import json
import logging
import re
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient


_MISSING = object()


def _write_plugin(root, plugin_id, *, offline=_MISSING, files=(), manifest_extra=None,
                  routes_body=None):
    plugin_dir = root / plugin_id
    plugin_dir.mkdir(parents=True)
    manifest = {"id": plugin_id, "name": plugin_id}
    if offline is not _MISSING:
        manifest["offline"] = offline
    manifest.update(manifest_extra or {})
    if routes_body is not None:
        manifest["routes"] = "routes.py"
        (plugin_dir / "routes.py").write_text(routes_body, encoding="utf-8")
    for relative in files:
        target = plugin_dir / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(f"// {relative}\n", encoding="utf-8")
    (plugin_dir / "plugin.json").write_text(json.dumps(manifest), encoding="utf-8")
    return plugin_dir


def _load_plugins(plugins, root):
    saved_dir = plugins.PLUGINS_DIR
    plugins.PLUGINS_DIR = root
    try:
        plugins.load_plugins(FastAPI(), {})
    finally:
        plugins.PLUGINS_DIR = saved_dir


def _api_rows(plugins):
    app = FastAPI()
    plugins.register_plugin_api(app)
    with TestClient(app) as client:
        return {row["id"]: row for row in client.get("/api/plugins").json()}


def test_valid_offline_assets_are_normalized_and_exposed_for_ready_and_pending_rows(
        tmp_path, reset_plugin_state):
    plugins = reset_plugin_state
    _write_plugin(
        tmp_path,
        "ready",
        offline={"assets": [" screen.js ", "assets/theme.css", "src/main.js"]},
        files=("screen.js", "assets/theme.css", "src/main.js"),
        manifest_extra={"script": "screen.js"},
    )
    _write_plugin(
        tmp_path,
        "failed",
        offline={"assets": ["screen.js"]},
        files=("screen.js",),
        manifest_extra={"script": "screen.js"},
        routes_body="def setup(app, context):\n    raise RuntimeError('boom')\n",
    )
    _write_plugin(tmp_path, "omitted")

    _load_plugins(plugins, tmp_path)
    rows = _api_rows(plugins)

    assert rows["ready"]["status"] == "ready"
    assert rows["ready"]["offline_assets"] == [
        "screen.js",
        "assets/theme.css",
        "src/main.js",
    ]
    assert rows["failed"]["status"] == "failed"
    assert rows["failed"]["offline_assets"] == ["screen.js"]
    assert rows["omitted"]["offline_assets"] == []


@pytest.mark.parametrize(
    ("route_path", "backing_path", "manifest_extra"),
    [
        ("screen.js", "client.js", {"script": "client.js"}),
        ("screen.html", "views/player.html", {"screen": "views/player.html"}),
        ("settings.html", "config/panel.html",
         {"settings": {"html": "config/panel.html"}}),
        ("tour.json", "tours/intro.json", {"tour": {"file": "tours/intro.json"}}),
    ],
)
def test_fixed_route_aliases_validate_manifest_selected_backing_files(
        route_path, backing_path, manifest_extra, tmp_path, reset_plugin_state):
    plugins = reset_plugin_state
    _write_plugin(
        tmp_path,
        "custom",
        offline={"assets": [route_path]},
        files=(backing_path,),
        manifest_extra=manifest_extra,
    )

    _load_plugins(plugins, tmp_path)

    assert _api_rows(plugins)["custom"]["offline_assets"] == [route_path]


@pytest.mark.parametrize(
    ("offline", "files", "manifest_extra"),
    [
        (None, (), {}),
        ("screen.js", (), {}),
        ({"assets": [], "policy": "cache-first"}, (), {}),
        ({"assets": "screen.js"}, (), {}),
        ({"assets": [1]}, (), {}),
        ({"assets": ["screen.js", " screen.js "]}, ("screen.js",),
         {"script": "screen.js"}),
        ({"assets": ["other.js"]}, ("other.js",), {}),
        ({"assets": ["assets/missing.css"]}, (), {}),
        ({"assets": ["screen.js"]}, (), {"script": "client.js"}),
        ({"assets": ["settings.html"]}, ("settings.html",), {}),
        ({"assets": ["src/main.js"]}, ("src/main.js",), {}),
    ],
    ids=[
        "offline-null",
        "offline-not-object",
        "unsupported-offline-key",
        "assets-not-list",
        "entry-not-string",
        "duplicate-after-trim",
        "unsupported-route",
        "missing-file",
        "missing-custom-target",
        "fixed-route-without-capability",
        "src-without-script",
    ],
)
def test_invalid_declarations_fail_closed_without_preventing_plugin_load(
        tmp_path, reset_plugin_state, caplog, offline, files, manifest_extra):
    plugins = reset_plugin_state
    _write_plugin(
        tmp_path,
        "invalid",
        offline=offline,
        files=files,
        manifest_extra=manifest_extra,
    )

    with caplog.at_level(logging.WARNING, logger=plugins.log.name):
        _load_plugins(plugins, tmp_path)

    loaded = next(plugin for plugin in plugins.LOADED_PLUGINS
                  if plugin["id"] == "invalid")
    assert loaded["offline_assets"] == []
    assert _api_rows(plugins)["invalid"]["offline_assets"] == []
    warnings = [record for record in caplog.records
                if "invalid offline.assets declaration" in record.getMessage()]
    assert len(warnings) == 1


@pytest.mark.parametrize("asset_path", [
    "/absolute.js",
    "C:/drive.js",
    "src//empty.js",
    "src/./dot.js",
    "src/../parent.js",
    "src\\backslash.js",
    "src/query.js?v=1",
    "src/fragment.js#part",
])
def test_unsafe_paths_fail_closed(asset_path, tmp_path, reset_plugin_state, caplog):
    plugins = reset_plugin_state
    _write_plugin(
        tmp_path,
        "unsafe",
        offline={"assets": [asset_path]},
        manifest_extra={"script": "screen.js"},
    )

    with caplog.at_level(logging.WARNING, logger=plugins.log.name):
        _load_plugins(plugins, tmp_path)

    loaded = next(plugin for plugin in plugins.LOADED_PLUGINS
                  if plugin["id"] == "unsafe")
    assert loaded["offline_assets"] == []
    warnings = [record for record in caplog.records
                if "invalid offline.assets declaration" in record.getMessage()]
    assert len(warnings) == 1


def test_symlink_escape_fails_closed(tmp_path, reset_plugin_state, caplog):
    plugins = reset_plugin_state
    outside = tmp_path / "outside.js"
    outside.write_text("// outside\n", encoding="utf-8")
    plugin_dir = _write_plugin(
        tmp_path,
        "linked",
        offline={"assets": ["assets/escape.js"]},
    )
    (plugin_dir / "assets").mkdir()
    try:
        (plugin_dir / "assets" / "escape.js").symlink_to(outside)
    except OSError as error:
        pytest.skip(f"symlinks unavailable: {error}")

    with caplog.at_level(logging.WARNING, logger=plugins.log.name):
        _load_plugins(plugins, tmp_path)

    loaded = next(plugin for plugin in plugins.LOADED_PLUGINS
                  if plugin["id"] == "linked")
    assert loaded["offline_assets"] == []
    warnings = [record for record in caplog.records
                if "invalid offline.assets declaration" in record.getMessage()]
    assert len(warnings) == 1


def test_published_schema_accepts_and_constrains_offline_asset_paths():
    schema_path = Path(__file__).resolve().parents[1] / "docs" / "plugin-manifest.schema.json"
    schema = json.loads(schema_path.read_text(encoding="utf-8"))
    offline = schema["properties"]["offline"]
    assets = offline["properties"]["assets"]
    pattern = re.compile(assets["items"]["pattern"])

    assert offline["type"] == "object"
    assert offline["additionalProperties"] is False
    assert assets["type"] == "array"
    assert assets["uniqueItems"] is True
    assert assets["items"]["type"] == "string"
    for valid in ("screen.js", "screen.html", "settings.html", "tour.json",
                  "src/main.js", "src/nested/module.js", "assets/plugin.css",
                  " screen.js "):
        assert pattern.fullmatch(valid), valid
    for invalid in ("", "   ", "/screen.js", "other.js", "src", "assets",
                    "src//x.js", "src/../x.js", "src/x.js?v=1", "assets\\x.css"):
        assert not pattern.fullmatch(invalid), invalid
