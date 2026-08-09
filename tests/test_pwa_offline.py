import importlib
import json
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


def test_worker_keeps_recovery_document_cache_and_limits_navigation_fallback():
    source = (V3_DIR / "service-worker.js").read_text(encoding="utf-8")

    assert "const OFFLINE_URL = '/static/v3/offline.html'" in source
    assert source.count("cache.add(") == 1
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
    assert "Can't reach your fee[dB]ack server" in response.text
    assert "does not mean your songs or profile data were lost" in response.text
    assert "window.location.reload()" in response.text
    assert "<link" not in response.text
    assert " src=" not in response.text


def test_existing_static_revalidation_contract_is_unchanged(client):
    response = client.get("/static/v3/manifest.json")

    assert response.status_code == 200
    assert response.headers["cache-control"] == "no-cache"
