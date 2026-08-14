import importlib
import json
import re
import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient


ROOT = Path(__file__).resolve().parents[1]
V3_DIR = ROOT / "static" / "v3"


@pytest.fixture()
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("CONFIG_DIR", str(tmp_path))
    monkeypatch.setenv("FEEDBACK_SKIP_STARTUP_TASKS", "1")
    sys.modules.pop("server", None)
    server = importlib.import_module("server")
    with TestClient(server.app) as test_client:
        yield test_client


def test_manifest_has_stable_identity_scope_and_start_url():
    manifest = json.loads((V3_DIR / "manifest.json").read_text(encoding="utf-8"))

    assert manifest["id"] == "/v3"
    assert manifest["start_url"] == "/v3"
    assert manifest["scope"] == "/"


def test_manifest_does_not_claim_unverified_maskable_icons():
    manifest = json.loads((V3_DIR / "manifest.json").read_text(encoding="utf-8"))
    png_icons = [icon for icon in manifest["icons"] if icon["type"] == "image/png"]

    assert {icon["sizes"] for icon in png_icons} == {"192x192", "512x512"}
    assert {icon["purpose"] for icon in png_icons} == {"any"}


def test_v3_document_registers_root_scoped_worker_safely():
    source = (V3_DIR / "index.html").read_text(encoding="utf-8")

    assert "'serviceWorker' in navigator" in source
    assert "register('/service-worker.js'" in source
    assert "scope: '/'" in source
    assert "updateViaCache: 'none'" in source
    assert ".catch(function ()" in source


def test_v3_document_loads_one_deferred_install_controller_and_system_row():
    source = (V3_DIR / "index.html").read_text(encoding="utf-8")

    assert source.count('src="/static/v3/pwa-install.js"') == 1
    assert '<script defer src="/static/v3/pwa-install.js"></script>' in source
    assert source.count('id="pwa-install-row"') == 1
    assert 'id="pwa-install-ios-dialog"' in source


@pytest.mark.parametrize("path", ["/", "/v3"])
def test_online_entry_routes_still_serve_v3_shell(client, path):
    response = client.get(path)

    assert response.status_code == 200
    assert "register('/service-worker.js'" in response.text


def test_service_worker_route_has_root_scope_and_no_stale_headers(client):
    response = client.get("/service-worker.js")

    assert response.status_code == 200
    assert response.headers["content-type"].startswith("application/javascript")
    assert response.headers["service-worker-allowed"] == "/"
    assert response.headers["cache-control"] == "no-cache, no-store, must-revalidate"


def test_worker_keeps_atomic_recovery_asset_cache_and_limits_navigation_fallback():
    source = (V3_DIR / "service-worker.js").read_text(encoding="utf-8")

    assert re.search(r"const CACHE_NAME = `\$\{CACHE_PREFIX\}v\d+`;", source)
    assert "const OFFLINE_URL = '/static/v3/offline.html'" in source
    assert "'/static/v3/offline-catalog.js'" in source
    assert "'/static/js/practice-package-store.js'" in source
    assert source.count("cache.addAll(") == 1
    assert "await caches.delete(CACHE_NAME)" in source
    assert "event.request.mode !== 'navigate'" in source
    assert "event.request.method !== 'GET'" in source
    assert "new Set(['/', '/v3', '/v3/'])" in source
    assert "url.origin !== self.location.origin" in source
    assert "!APP_ENTRY_PATHS.has(url.pathname)" in source
    assert "key.startsWith(CACHE_PREFIX)" in source
    assert "caches.delete(key)" in source


def test_worker_falls_back_for_network_errors_and_transient_proxy_responses():
    source = (V3_DIR / "service-worker.js").read_text(encoding="utf-8")

    assert "new Set([502, 503, 504])" in source
    assert "new Request(event.request, { cache: 'no-store' })" in source
    assert "fetch(networkRequest)" in source
    assert "TRANSIENT_UNAVAILABLE_STATUSES.has(response.status)" in source
    assert ": response" in source
    assert ".catch(() => offlineResponse())" in source


def test_offline_document_is_self_contained_and_retries(client):
    response = client.get("/static/v3/offline.html")

    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/html")
    assert response.headers["cache-control"] == "no-cache"
    assert "Downloaded practice" in response.text
    assert "Your fee[dB]ack server cannot be reached." in response.text
    assert "practice packages saved on this device" in response.text
    assert "window.location.assign('/v3/')" in response.text
    assert 'id="offline-package-manager" hidden' in response.text
    assert 'type="module" src="/static/v3/offline-catalog.js"' in response.text
    assert response.text.index("window.location.assign('/v3/')") < response.text.index(
        'src="/static/v3/offline-catalog.js"'
    )
    assert "/static/app.js" not in response.text
    assert "plugin" not in response.text.lower()
    assert "<link" not in response.text


def test_offline_only_assets_stay_outside_normal_shell_manifest():
    manifest = json.loads((V3_DIR / "pwa-shell-assets.json").read_text(encoding="utf-8"))

    assert "/static/v3/offline.html" not in manifest["assets"]
    assert "/static/v3/offline-catalog.js" not in manifest["assets"]


def test_existing_static_revalidation_contract_is_unchanged(client):
    response = client.get("/static/v3/manifest.json")

    assert response.status_code == 200
    assert response.headers["cache-control"] == "no-cache"
