#!/usr/bin/env python3
"""Generate the deterministic v3 PWA shell asset inventory.

The scanner intentionally covers only dependencies that load as part of the
existing document graph:

* local ``src``/``href``/``poster`` attributes parsed with ``HTMLParser``;
* static JavaScript ``import`` and ``export ... from`` declarations whose
  specifiers are quoted strings;
* explicitly approved dynamic module roots plus their static import graphs;
* CSS ``url(...)`` values that are quoted or simple unquoted strings; and
* icon sources from the linked web app manifest, parsed as JSON.

Dynamic ``import()`` calls are not eager shell dependencies. Malformed static
declarations and CSS URL expressions fail generation instead of silently
producing an incomplete inventory.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from html.parser import HTMLParser
from pathlib import Path, PurePosixPath
from urllib.parse import urljoin, urlsplit


SCHEMA = "feedback.pwa-shell-assets.v1"
SOURCE_URL = "/static/v3/index.html"
OUTPUT_URL = "/static/v3/pwa-shell-assets.json"

# dashboard.js inserts this image at render time, so no structural HTML/CSS
# reference exists for the generator to discover.
DYNAMIC_SHELL_ASSETS = (
    "/static/v3/brand/hero.png",
    "/static/assets/venue/themes/small-club/bass-pov-bg.webp",
    "/static/assets/venue/themes/small-club/bg-plate.webp",
    "/static/assets/venue/themes/small-club/drums-pov-bg.webp",
    "/static/assets/venue/themes/small-club/guitar-pov-bg.webp",
    "/static/assets/venue/themes/small-club/piano-pov-bg.webp",
    "/static/assets/venue/themes/small-club/vocals-pov-bg.webp",
)

# These modules are loaded through approved runtime import() paths. Seed them
# explicitly, then use the same static-import traversal as document modules.
DYNAMIC_MODULE_ROOTS = (
    "/static/vendor/three/three.module.min.js",
    "/static/vendor/three/addons/postprocessing/EffectComposer.js",
    "/static/vendor/three/addons/postprocessing/RenderPass.js",
    "/static/vendor/three/addons/postprocessing/UnrealBloomPass.js",
    "/static/vendor/three/addons/postprocessing/OutputPass.js",
)


class ManifestGenerationError(RuntimeError):
    """Raised when a local dependency cannot be represented safely."""


class ShellHTMLParser(HTMLParser):
    """Collect URL-bearing attributes and ES-module roots from the v3 HTML."""

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.references: list[tuple[str, str, str]] = []
        self.module_sources: list[str] = []
        self.web_manifests: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        values = {name.lower(): value for name, value in attrs if value is not None}
        for attr in ("src", "href", "poster"):
            value = values.get(attr)
            if value:
                self.references.append((value, tag.lower(), attr))

        if tag.lower() == "script" and values.get("type", "").lower() == "module":
            source = values.get("src")
            if source:
                self.module_sources.append(source)

        if tag.lower() == "link" and "manifest" in values.get("rel", "").lower().split():
            href = values.get("href")
            if href:
                self.web_manifests.append(href)


def _read_js_string(source: str, start: int, context: Path) -> tuple[str, int]:
    quote = source[start]
    if quote not in ("'", '"'):
        raise ManifestGenerationError(f"{context}: expected a quoted module specifier")
    chars: list[str] = []
    index = start + 1
    while index < len(source):
        char = source[index]
        if char == quote:
            return "".join(chars), index + 1
        if char == "\\":
            raise ManifestGenerationError(
                f"{context}: escaped module specifiers are not supported"
            )
        if char in "\r\n":
            raise ManifestGenerationError(f"{context}: unterminated module specifier")
        chars.append(char)
        index += 1
    raise ManifestGenerationError(f"{context}: unterminated module specifier")


def _skip_js_string(source: str, start: int, context: Path) -> int:
    quote = source[start]
    if quote == "`":
        return _skip_js_template(source, start, context)
    index = start + 1
    while index < len(source):
        char = source[index]
        if char == "\\":
            index += 2
            continue
        if char == quote:
            return index + 1
        index += 1
    raise ManifestGenerationError(f"{context}: unterminated JavaScript string")


def _looks_like_js_regex(source: str, start: int) -> bool:
    """Conservatively identify regex literals while walking ordinary JS code."""

    index = start - 1
    while index >= 0 and source[index].isspace():
        index -= 1
    if index < 0:
        return True
    return source[index] in "([{:;,=!?&|+-*%^~<>"


def _skip_js_regex(source: str, start: int, context: Path) -> int:
    line = source.count("\n", 0, start) + 1
    index = start + 1
    in_character_class = False
    while index < len(source):
        char = source[index]
        if char == "\\":
            index += 2
            continue
        if char in "\r\n":
            raise ManifestGenerationError(
                f"{context}:{line}: unterminated JavaScript regex"
            )
        if char == "[":
            in_character_class = True
        elif char == "]":
            in_character_class = False
        elif char == "/" and not in_character_class:
            index += 1
            while index < len(source) and source[index].isalpha():
                index += 1
            return index
        index += 1
    raise ManifestGenerationError(f"{context}:{line}: unterminated JavaScript regex")


def _skip_js_template_expression(source: str, start: int, context: Path) -> int:
    index = start
    depth = 1
    while index < len(source):
        if source.startswith("//", index):
            newline = source.find("\n", index + 2)
            index = len(source) if newline < 0 else newline + 1
            continue
        if source.startswith("/*", index):
            end = source.find("*/", index + 2)
            if end < 0:
                raise ManifestGenerationError(f"{context}: unterminated JavaScript comment")
            index = end + 2
            continue

        char = source[index]
        if char in ("'", '"', "`"):
            index = _skip_js_string(source, index, context)
            continue
        if char == "/" and _looks_like_js_regex(source, index):
            index = _skip_js_regex(source, index, context)
            continue
        if char == "{":
            depth += 1
        elif char == "}":
            depth -= 1
            if depth == 0:
                return index + 1
        index += 1
    raise ManifestGenerationError(f"{context}: unterminated template expression")


def _skip_js_template(source: str, start: int, context: Path) -> int:
    index = start + 1
    while index < len(source):
        if source[index] == "\\":
            index += 2
            continue
        if source[index] == "`":
            return index + 1
        if source.startswith("${", index):
            index = _skip_js_template_expression(source, index + 2, context)
            continue
        index += 1
    raise ManifestGenerationError(f"{context}: unterminated JavaScript template")


def _skip_js_space_and_comments(source: str, start: int, context: Path) -> int:
    index = start
    while index < len(source):
        if source[index].isspace():
            index += 1
            continue
        if source.startswith("//", index):
            newline = source.find("\n", index + 2)
            return len(source) if newline < 0 else _skip_js_space_and_comments(source, newline + 1, context)
        if source.startswith("/*", index):
            end = source.find("*/", index + 2)
            if end < 0:
                raise ManifestGenerationError(f"{context}: unterminated JavaScript comment")
            index = end + 2
            continue
        break
    return index


def _scan_declaration_for_from(
    source: str,
    start: int,
    context: Path,
) -> tuple[str | None, int]:
    """Find a quoted ``from`` specifier before a declaration semicolon."""

    index = start
    depths = {"(": 0, "[": 0, "{": 0}
    closers = {")": "(", "]": "[", "}": "{"}
    while index < len(source):
        if source.startswith("//", index):
            newline = source.find("\n", index + 2)
            index = len(source) if newline < 0 else newline + 1
            continue
        if source.startswith("/*", index):
            end = source.find("*/", index + 2)
            if end < 0:
                raise ManifestGenerationError(f"{context}: unterminated JavaScript comment")
            index = end + 2
            continue

        char = source[index]
        if char == "/" and _looks_like_js_regex(source, index):
            index = _skip_js_regex(source, index, context)
            continue
        if char in ("'", '"', "`"):
            index = _skip_js_string(source, index, context)
            continue
        if char in depths:
            depths[char] += 1
            index += 1
            continue
        if char in closers:
            opener = closers[char]
            depths[opener] = max(0, depths[opener] - 1)
            index += 1
            continue
        if char == ";" and not any(depths.values()):
            return None, index + 1
        if char.isalpha() or char in "_$":
            end = index + 1
            while end < len(source) and (source[end].isalnum() or source[end] in "_$"):
                end += 1
            if source[index:end] == "from" and not any(depths.values()):
                specifier_start = _skip_js_space_and_comments(source, end, context)
                if specifier_start >= len(source) or source[specifier_start] not in ("'", '"'):
                    raise ManifestGenerationError(
                        f"{context}: static module dependency after 'from' must be quoted"
                    )
                specifier, specifier_end = _read_js_string(source, specifier_start, context)
                semicolon = source.find(";", specifier_end)
                if semicolon < 0:
                    raise ManifestGenerationError(
                        f"{context}: static module declaration must end with a semicolon"
                    )
                return specifier, semicolon + 1
            index = end
            continue
        index += 1

    raise ManifestGenerationError(
        f"{context}: static module declaration must end with a semicolon"
    )


def scan_static_module_specifiers(source: str, context: Path) -> list[str]:
    """Return eager module specifiers from supported top-level declarations."""

    specifiers: list[str] = []
    index = 0
    depths = {"(": 0, "[": 0, "{": 0}
    closers = {")": "(", "]": "[", "}": "{"}

    while index < len(source):
        if source.startswith("//", index):
            newline = source.find("\n", index + 2)
            index = len(source) if newline < 0 else newline + 1
            continue
        if source.startswith("/*", index):
            end = source.find("*/", index + 2)
            if end < 0:
                raise ManifestGenerationError(f"{context}: unterminated JavaScript comment")
            index = end + 2
            continue

        char = source[index]
        if char == "/" and _looks_like_js_regex(source, index):
            index = _skip_js_regex(source, index, context)
            continue
        if char in ("'", '"', "`"):
            index = _skip_js_string(source, index, context)
            continue
        if char in depths:
            depths[char] += 1
            index += 1
            continue
        if char in closers:
            opener = closers[char]
            depths[opener] = max(0, depths[opener] - 1)
            index += 1
            continue
        if char.isalpha() or char in "_$":
            end = index + 1
            while end < len(source) and (source[end].isalnum() or source[end] in "_$"):
                end += 1
            word = source[index:end]
            if not any(depths.values()) and word in ("import", "export"):
                cursor = _skip_js_space_and_comments(source, end, context)
                if word == "import":
                    if cursor < len(source) and source[cursor] in ("(", "."):
                        index = end
                        continue
                    if cursor < len(source) and source[cursor] in ("'", '"'):
                        specifier, cursor = _read_js_string(source, cursor, context)
                        semicolon = source.find(";", cursor)
                        if semicolon < 0:
                            raise ManifestGenerationError(
                                f"{context}: static module declaration must end with a semicolon"
                            )
                        specifiers.append(specifier)
                        index = semicolon + 1
                        continue
                    specifier, cursor = _scan_declaration_for_from(source, cursor, context)
                    if specifier is None:
                        raise ManifestGenerationError(
                            f"{context}: unsupported static import declaration"
                        )
                    specifiers.append(specifier)
                    index = cursor
                    continue

                declaration = source[cursor:cursor + 16]
                if re.match(r"(?:async\s+)?(?:function|class)\b", declaration) or re.match(
                    r"(?:const|let|var|default)\b", declaration
                ):
                    index = end
                    continue
                if cursor < len(source) and source[cursor] in ("*", "{"):
                    specifier, cursor = _scan_declaration_for_from(source, cursor, context)
                    if specifier is not None:
                        specifiers.append(specifier)
                    index = cursor
                    continue
                raise ManifestGenerationError(f"{context}: unsupported export declaration")
            index = end
            continue
        index += 1

    return specifiers


def scan_css_urls(source: str, context: Path) -> list[str]:
    """Return simple CSS ``url(...)`` values, rejecting malformed expressions."""

    urls: list[str] = []
    for match in re.finditer(r"(?i)\burl\s*\(", source):
        index = match.end()
        while index < len(source) and source[index].isspace():
            index += 1
        if index >= len(source):
            raise ManifestGenerationError(f"{context}: unterminated CSS url()")

        if source[index] in ("'", '"'):
            quote = source[index]
            end = index + 1
            while end < len(source) and source[end] != quote:
                if source[end] == "\\":
                    raise ManifestGenerationError(
                        f"{context}: escaped CSS url() values are not supported"
                    )
                end += 1
            if end >= len(source):
                raise ManifestGenerationError(f"{context}: unterminated CSS url() string")
            value = source[index + 1:end]
            close = end + 1
            while close < len(source) and source[close].isspace():
                close += 1
            if close >= len(source) or source[close] != ")":
                raise ManifestGenerationError(f"{context}: malformed CSS url()")
        else:
            close = source.find(")", index)
            if close < 0:
                raise ManifestGenerationError(f"{context}: unterminated CSS url()")
            value = source[index:close].strip()
            if not value or any(char in value for char in "'\""):
                raise ManifestGenerationError(f"{context}: malformed CSS url()")
        urls.append(value)
    return urls


def _normalize_static_url(raw_url: str, base_url: str, context: Path) -> str | None:
    raw_url = raw_url.strip()
    if not raw_url or raw_url.startswith(("#", "data:", "blob:")):
        return None
    if "\\" in raw_url:
        raise ManifestGenerationError(f"{context}: backslashes are not valid asset paths: {raw_url}")

    parsed_raw = urlsplit(raw_url)
    if parsed_raw.scheme or parsed_raw.netloc or raw_url.startswith("//"):
        return None

    resolved = urljoin(base_url, raw_url)
    parsed = urlsplit(resolved)
    if parsed.query or parsed.fragment:
        if parsed.path.startswith("/static/"):
            raise ManifestGenerationError(
                f"{context}: local static dependencies cannot contain query strings or fragments: {raw_url}"
            )
        return None
    if not parsed.path.startswith("/static/"):
        if raw_url.startswith((".", "/static/")):
            raise ManifestGenerationError(
                f"{context}: local dependency escapes the static namespace: {raw_url}"
            )
        return None
    if "\\" in parsed.path:
        raise ManifestGenerationError(f"{context}: backslashes are not valid asset paths: {raw_url}")

    path = PurePosixPath(parsed.path)
    if any(part in (".", "..") for part in path.parts) or str(path) != parsed.path:
        raise ManifestGenerationError(f"{context}: unsafe asset path: {raw_url}")
    return parsed.path


def _asset_path(repo_root: Path, url: str, context: Path) -> Path:
    static_root = (repo_root / "static").resolve()
    target = (repo_root / url.lstrip("/")).resolve()
    try:
        target.relative_to(static_root)
    except ValueError as exc:
        raise ManifestGenerationError(f"{context}: asset escapes static/: {url}") from exc
    if not target.is_file():
        raise ManifestGenerationError(f"{context}: asset does not exist: {url}")
    return target


def generate_manifest(
    repo_root: Path,
    *,
    dynamic_assets: tuple[str, ...] | None = None,
    dynamic_module_roots: tuple[str, ...] | None = None,
) -> dict[str, object]:
    repo_root = repo_root.resolve()
    if dynamic_assets is None:
        dynamic_assets = DYNAMIC_SHELL_ASSETS
    if dynamic_module_roots is None:
        dynamic_module_roots = DYNAMIC_MODULE_ROOTS
    index_path = _asset_path(repo_root, SOURCE_URL, Path("index.html"))
    parser = ShellHTMLParser()
    parser.feed(index_path.read_text(encoding="utf-8"))
    parser.close()

    assets: set[str] = {SOURCE_URL}
    module_queue: list[str] = []
    css_queue: list[str] = []
    manifest_queue: list[str] = []

    def add(raw_url: str, base_url: str, context: Path) -> str | None:
        url = _normalize_static_url(raw_url, base_url, context)
        if url is None:
            return None
        _asset_path(repo_root, url, context)
        if url not in assets:
            assets.add(url)
            if url.endswith(".css"):
                css_queue.append(url)
        return url

    for raw_url, tag, attr in parser.references:
        add(raw_url, SOURCE_URL, Path(f"index.html <{tag}> {attr}"))
    for raw_url in parser.module_sources:
        url = add(raw_url, SOURCE_URL, Path("index.html module script"))
        if url:
            module_queue.append(url)
    for raw_url in dynamic_module_roots:
        url = add(raw_url, SOURCE_URL, Path("DYNAMIC_MODULE_ROOTS"))
        if url:
            module_queue.append(url)
    for raw_url in parser.web_manifests:
        url = add(raw_url, SOURCE_URL, Path("index.html web manifest"))
        if url:
            manifest_queue.append(url)

    seen_modules: set[str] = set()
    while module_queue:
        module_url = module_queue.pop()
        if module_url in seen_modules:
            continue
        seen_modules.add(module_url)
        module_path = _asset_path(repo_root, module_url, Path(module_url))
        source = module_path.read_text(encoding="utf-8")
        for specifier in scan_static_module_specifiers(source, module_path):
            parsed_specifier = urlsplit(specifier)
            if (
                parsed_specifier.scheme
                or parsed_specifier.netloc
                or specifier.startswith("//")
            ):
                continue
            if not specifier.startswith((".", "/")):
                raise ManifestGenerationError(
                    f"{module_path}: unsupported bare module specifier: {specifier}"
                )
            dependency = add(specifier, module_url, module_path)
            if dependency:
                module_queue.append(dependency)

    seen_css: set[str] = set()
    while css_queue:
        css_url = css_queue.pop()
        if css_url in seen_css:
            continue
        seen_css.add(css_url)
        css_path = _asset_path(repo_root, css_url, Path(css_url))
        source = css_path.read_text(encoding="utf-8")
        if re.search(r"(?i)@import\b", source):
            raise ManifestGenerationError(
                f"{css_path}: CSS @import is not supported; load the stylesheet from HTML"
            )
        for dependency in scan_css_urls(source, css_path):
            add(dependency, css_url, css_path)

    for manifest_url in manifest_queue:
        manifest_path = _asset_path(repo_root, manifest_url, Path(manifest_url))
        try:
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        except json.JSONDecodeError as exc:
            raise ManifestGenerationError(f"{manifest_path}: invalid JSON: {exc}") from exc
        icons = manifest.get("icons", [])
        if not isinstance(icons, list):
            raise ManifestGenerationError(f"{manifest_path}: icons must be a list")
        for icon in icons:
            if not isinstance(icon, dict) or not isinstance(icon.get("src"), str):
                raise ManifestGenerationError(f"{manifest_path}: every icon must have a string src")
            add(icon["src"], manifest_url, manifest_path)

    for dynamic_url in dynamic_assets:
        add(dynamic_url, SOURCE_URL, Path("DYNAMIC_SHELL_ASSETS"))

    return {
        "schema": SCHEMA,
        "source": SOURCE_URL,
        "assets": sorted(assets),
    }


def render_manifest(manifest: dict[str, object]) -> str:
    return json.dumps(manifest, indent=2, ensure_ascii=True) + "\n"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--check",
        action="store_true",
        help="fail if the committed manifest is missing or stale without rewriting it",
    )
    args = parser.parse_args(argv)

    repo_root = Path(__file__).resolve().parents[1]
    output_path = repo_root / OUTPUT_URL.lstrip("/")
    try:
        rendered = render_manifest(generate_manifest(repo_root))
    except (ManifestGenerationError, OSError, UnicodeError) as exc:
        print(f"PWA shell manifest generation failed: {exc}", file=sys.stderr)
        return 1

    current = output_path.read_text(encoding="utf-8") if output_path.exists() else None
    if args.check:
        if current != rendered:
            print(
                "PWA shell manifest is stale; run "
                "python scripts/generate_pwa_shell_manifest.py",
                file=sys.stderr,
            )
            return 1
        print(f"PWA shell manifest is current ({len(json.loads(rendered)['assets'])} assets).")
        return 0

    if current != rendered:
        output_path.write_text(rendered, encoding="utf-8", newline="\n")
        print(f"Updated {output_path.relative_to(repo_root)}.")
    else:
        print(f"{output_path.relative_to(repo_root)} is already current.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
