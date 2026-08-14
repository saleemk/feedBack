import importlib.util
import json
import subprocess
import sys
from pathlib import Path

import pytest


ROOT = Path(__file__).resolve().parents[1]
GENERATOR_PATH = ROOT / "scripts" / "generate_pwa_shell_manifest.py"
OUTPUT_PATH = ROOT / "static" / "v3" / "pwa-shell-assets.json"

THREE_MODULE_GRAPH = {
    "/static/vendor/three/three.module.min.js",
    "/static/vendor/three/addons/postprocessing/EffectComposer.js",
    "/static/vendor/three/addons/postprocessing/MaskPass.js",
    "/static/vendor/three/addons/postprocessing/OutputPass.js",
    "/static/vendor/three/addons/postprocessing/Pass.js",
    "/static/vendor/three/addons/postprocessing/RenderPass.js",
    "/static/vendor/three/addons/postprocessing/ShaderPass.js",
    "/static/vendor/three/addons/postprocessing/UnrealBloomPass.js",
    "/static/vendor/three/addons/shaders/CopyShader.js",
    "/static/vendor/three/addons/shaders/LuminosityHighPassShader.js",
    "/static/vendor/three/addons/shaders/OutputShader.js",
}
VENUE_WEBP_PLATES = {
    f"/static/assets/venue/themes/small-club/{name}-pov-bg.webp"
    for name in ("bass", "drums", "guitar", "piano", "vocals")
} | {"/static/assets/venue/themes/small-club/bg-plate.webp"}

SPEC = importlib.util.spec_from_file_location("generate_pwa_shell_manifest", GENERATOR_PATH)
assert SPEC and SPEC.loader
generator = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(generator)


def _write(root: Path, relative: str, content: str = "") -> None:
    path = root / relative
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")


def test_committed_manifest_is_fresh_and_check_mode_passes():
    committed = json.loads(OUTPUT_PATH.read_text(encoding="utf-8"))

    assert committed == generator.generate_manifest(ROOT)

    result = subprocess.run(
        [sys.executable, str(GENERATOR_PATH), "--check"],
        cwd=ROOT,
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.returncode == 0, result.stderr
    assert "manifest is current" in result.stdout


def test_check_mode_rejects_stale_artifact_without_rewriting(
    tmp_path, monkeypatch, capsys
):
    _write(tmp_path, "static/v3/index.html", "<!doctype html>\n")
    _write(tmp_path, "static/v3/brand/hero.png")
    _write(tmp_path, "static/v3/pwa-shell-assets.json", "stale\n")
    monkeypatch.setattr(
        generator, "__file__", str(tmp_path / "scripts" / GENERATOR_PATH.name)
    )
    monkeypatch.setattr(generator, "DYNAMIC_SHELL_ASSETS", ())
    monkeypatch.setattr(generator, "DYNAMIC_MODULE_ROOTS", ())

    assert generator.main(["--check"]) == 1
    assert (tmp_path / "static/v3/pwa-shell-assets.json").read_text() == "stale\n"
    assert "manifest is stale" in capsys.readouterr().err


def test_generated_assets_are_sorted_unique_existing_static_files():
    manifest = generator.generate_manifest(ROOT)
    assets = manifest["assets"]

    assert manifest["schema"] == "feedback.pwa-shell-assets.v1"
    assert manifest["source"] == "/static/v3/index.html"
    assert assets == sorted(set(assets))
    assert "/static/v3/index.html" in assets
    assert "/static/v3/offline.html" not in assets
    assert "/static/v3/service-worker.js" not in assets

    static_root = (ROOT / "static").resolve()
    for url in assets:
        assert url.startswith("/static/")
        assert not any(char in url for char in ("?", "#", "\\"))
        target = (ROOT / url.lstrip("/")).resolve()
        target.relative_to(static_root)
        assert target.is_file(), url


def test_real_manifest_covers_each_dependency_source():
    assets = set(generator.generate_manifest(ROOT)["assets"])

    assert {
        "/static/v3/index.html",
        "/static/tailwind.min.css",
        "/static/app.js",
        "/static/js/plugin-loader.js",
        "/static/js/blob-io.js",
        "/static/v3/overlay-active.png",
        "/static/v3/overlay-inactive.png",
        "/static/v3/manifest.json",
        "/static/v3/brand/icon-192.png",
        "/static/v3/brand/icon-512.png",
        "/static/v3/brand/hero.png",
        "/static/svg/play.svg",
        "/static/svg/pause.svg",
    } <= assets

    assert not any(url.startswith("/api/") for url in assets)
    assert not any("google" in url.lower() for url in assets)


def test_real_manifest_contains_approved_3d_graph_and_venue_plates_only():
    assets = set(generator.generate_manifest(ROOT)["assets"])

    assert THREE_MODULE_GRAPH <= assets
    assert VENUE_WEBP_PLATES <= assets
    assert not any(
        url.startswith("/static/assets/venue/themes/small-club/")
        and url.endswith(".png")
        for url in assets
    )
    assert not any(url.endswith(("/current.mp4", "/current.webm")) for url in assets)
    assert not any(url.startswith("/api/plugins/") for url in assets)


def test_synthetic_graph_recurses_and_excludes_non_static_routes(tmp_path):
    _write(
        tmp_path,
        "static/v3/index.html",
        """<!doctype html>
        <link rel="stylesheet" href="/static/v3/shell.css">
        <link rel="manifest" href="/static/v3/manifest.json">
        <link rel="stylesheet" href="https://fonts.example/font.css?x=1">
        <script type="module" src="/static/app.js"></script>
        <script defer src="/api/plugins/example/screen.js"></script>
        """,
    )
    _write(
        tmp_path,
        "static/app.js",
        """import './dep.js';
        export { value } from './reexport.js';
        import 'https://cdn.example/external.js';
        import('./lazy.js');
        """,
    )
    _write(tmp_path, "static/dep.js", "import './nested.js';\n")
    _write(tmp_path, "static/nested.js", "export const nested = true;\n")
    _write(tmp_path, "static/reexport.js", "export const value = true;\n")
    _write(tmp_path, "static/lazy.js", "export const lazy = true;\n")
    _write(tmp_path, "static/v3/shell.css", "body { background: url('./bg.png'); }\n")
    _write(tmp_path, "static/v3/bg.png")
    _write(
        tmp_path,
        "static/v3/manifest.json",
        json.dumps({"icons": [{"src": "brand/icon.png"}]}),
    )
    _write(tmp_path, "static/v3/brand/icon.png")

    manifest = generator.generate_manifest(
        tmp_path,
        dynamic_assets=(),
        dynamic_module_roots=(),
    )

    assert manifest["assets"] == sorted([
        "/static/app.js",
        "/static/dep.js",
        "/static/nested.js",
        "/static/reexport.js",
        "/static/v3/bg.png",
        "/static/v3/brand/icon.png",
        "/static/v3/index.html",
        "/static/v3/manifest.json",
        "/static/v3/shell.css",
    ])
    assert "/static/lazy.js" not in manifest["assets"]


def test_approved_dynamic_module_roots_recurse_through_static_imports(tmp_path):
    _write(tmp_path, "static/v3/index.html", "<!doctype html>\n")
    _write(
        tmp_path,
        "static/runtime/root.js",
        "import './nested.js';\nimport('./lazy.js');\n",
    )
    _write(tmp_path, "static/runtime/nested.js", "export { value } from './leaf.js';\n")
    _write(tmp_path, "static/runtime/leaf.js", "export const value = true;\n")
    _write(tmp_path, "static/runtime/lazy.js", "export const lazy = true;\n")

    assets = set(generator.generate_manifest(
        tmp_path,
        dynamic_assets=(),
        dynamic_module_roots=("/static/runtime/root.js",),
    )["assets"])

    assert {
        "/static/runtime/root.js",
        "/static/runtime/nested.js",
        "/static/runtime/leaf.js",
    } <= assets
    assert "/static/runtime/lazy.js" not in assets


def test_bare_module_specifiers_fail_clearly(tmp_path):
    _write(
        tmp_path,
        "static/v3/index.html",
        '<script type="module" src="/static/app.js"></script>',
    )
    _write(tmp_path, "static/app.js", "import 'package-name';\n")

    with pytest.raises(generator.ManifestGenerationError, match="bare module specifier"):
        generator.generate_manifest(
            tmp_path,
            dynamic_assets=(),
            dynamic_module_roots=(),
        )


@pytest.mark.parametrize(
    "url",
    [
        "/static/app.js?v=1",
        "/static/app.js#fragment",
        "/static/../server.py",
        "../../server.py",
        "/static\\app.js",
    ],
)
def test_unsafe_local_references_are_rejected(url):
    with pytest.raises(generator.ManifestGenerationError):
        generator._normalize_static_url(url, "/static/v3/index.html", Path("fixture"))


def test_external_and_api_references_are_ignored():
    assert generator._normalize_static_url(
        "https://example.com/app.js?x=1", "/static/v3/index.html", Path("fixture")
    ) is None
    assert generator._normalize_static_url(
        "/api/plugins/example/screen.js", "/static/v3/index.html", Path("fixture")
    ) is None


def test_malformed_supported_dependency_syntax_fails_clearly():
    with pytest.raises(generator.ManifestGenerationError, match="unsupported static import"):
        generator.scan_static_module_specifiers(
            "import dependency './dep.js';", Path("fixture.js")
        )
    with pytest.raises(generator.ManifestGenerationError, match="malformed CSS url"):
        generator.scan_css_urls(
            "body { background: url('/static/bg.png'; }", Path("fixture.css")
        )
