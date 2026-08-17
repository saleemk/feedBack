"""Contract tests for V1 downloadable practice-package endpoints."""

from __future__ import annotations

import asyncio
import hashlib
import importlib
import json
import sys
from pathlib import Path

import pytest
import yaml
from fastapi.testclient import TestClient

import practice_package as practice_package_mod
from highway_snapshot import stream_highway_snapshot
from routers import practice_package as practice_package_router


FULL_MIX_BYTES = b"OggS-complete-mix-for-practice-package"


def _arrangement(name: str, *, populated_template: bool) -> dict:
    return {
        "name": name,
        "tuning": [0, 0, 0, 0, 0, 0],
        "capo": 0,
        "centOffset": 0.0,
        "notes": [{"t": 1.0, "s": 0, "f": 3}],
        "chords": [],
        "anchors": [],
        "handshapes": [],
        "templates": ([{
            "name": "Am",
            "displayName": "A minor",
            "frets": [-1, 0, 2, 2, 1, 0],
            "fingers": [-1, 0, 2, 3, 1, 0],
        }] if populated_template else []),
        "phrases": [],
        "beats": [],
        "sections": [],
    }


def _write_pack(
    dlc: Path,
    filename: str,
    *,
    stems: list[dict] | None = None,
    arrangements: list[tuple[str, bool]] | None = None,
) -> Path:
    pak = dlc / filename
    (pak / "arrangements").mkdir(parents=True)
    (pak / "stems").mkdir()
    if stems is None:
        stems = [
            {"id": "full", "file": "stems/full.ogg", "default": True},
            {"id": "guitar", "file": "stems/guitar.ogg", "default": True},
        ]
    if arrangements is None:
        arrangements = [("Lead", False), ("Rhythm", True)]

    arrangement_entries = []
    for index, (name, populated_template) in enumerate(arrangements):
        arrangement_id = name.lower()
        rel_path = f"arrangements/{index}-{arrangement_id}.json"
        (pak / rel_path).write_text(
            json.dumps(_arrangement(name, populated_template=populated_template)),
            encoding="utf-8",
        )
        arrangement_entries.append({
            "id": arrangement_id,
            "name": name,
            "file": rel_path,
        })

    for stem in stems:
        target = pak / stem["file"]
        target.parent.mkdir(parents=True, exist_ok=True)
        payload = FULL_MIX_BYTES if stem["id"] == "full" else stem["id"].encode()
        target.write_bytes(payload)

    (pak / "manifest.yaml").write_text(yaml.safe_dump({
        "title": "Practice Song",
        "artist": "Test Artist",
        "duration": 42.5,
        "arrangements": arrangement_entries,
        "stems": stems,
    }, sort_keys=False), encoding="utf-8")
    return pak


@pytest.fixture()
def package_client(tmp_path, monkeypatch):
    dlc = tmp_path / "dlc"
    config = tmp_path / "config"
    dlc.mkdir()
    config.mkdir()
    monkeypatch.setenv("DLC_DIR", str(dlc))
    monkeypatch.setenv("CONFIG_DIR", str(config))
    monkeypatch.setenv("FEEDBACK_SYNC_STARTUP", "1")
    sys.modules.pop("server", None)
    server = importlib.import_module("server")
    server.sloppak_mod._source_cache.clear()
    monkeypatch.setattr(server, "load_plugins", lambda *args, **kwargs: None)
    monkeypatch.setattr(server, "startup_scan", lambda: None)
    client = TestClient(server.app, client=("127.0.0.1", 50000))
    try:
        yield client, dlc
    finally:
        client.close()
        conn = getattr(getattr(server, "meta_db", None), "conn", None)
        if conn is not None:
            getattr(
                sys.modules.get("server"), "_join_background_db_threads", lambda: None
            )()
            conn.close()


def _canonical_messages(filename: str, **options) -> list[dict]:
    messages = []

    async def collect(message):
        messages.append(message)

    asyncio.run(stream_highway_snapshot(filename, emit=collect, **options))
    return messages


def test_manifest_chart_and_audio_match_canonical_artifacts(package_client):
    client, dlc = package_client
    filename = "Artist Name/Practice Song.feedpak"
    _write_pack(dlc, filename)

    response = client.get("/api/practice-package/manifest", params={
        "filename": filename,
        "arrangement": 1,
        "naming_mode": "smart",
    })
    assert response.status_code == 200, response.text
    manifest = response.json()
    assert manifest["schema"] == "feedback.practice-package.manifest.v1"
    assert manifest["source"] == {"filename": filename}
    assert manifest["song"] == {
        "title": "Practice Song",
        "artist": "Test Artist",
        "duration": 42.5,
    }
    assert manifest["arrangement"] == {
        "index": 1,
        "name": "Rhythm",
        "smart_name": "Rhythm",
        "naming_mode": "smart",
        "drum_part": None,
    }
    assert str(dlc) not in response.text

    chart_response = client.get(manifest["chart"]["url"])
    assert chart_response.status_code == 200, chart_response.text
    assert chart_response.headers["content-type"].startswith("application/x-ndjson")
    assert chart_response.content.endswith(b"\n")
    chart_messages = [json.loads(line) for line in chart_response.content.splitlines()]
    canonical = _canonical_messages(filename, arrangement=1, naming_mode="smart")
    assert chart_messages == canonical
    assert chart_messages[0]["type"] == "song_info"
    assert chart_messages[-1] == {"type": "ready"}
    assert manifest["chart"]["bytes"] == len(chart_response.content)
    assert manifest["chart"]["media_type"] == "application/x-ndjson"
    assert manifest["chart"]["sha256"] == hashlib.sha256(
        chart_response.content
    ).hexdigest()

    audio_response = client.get(manifest["audio"]["url"])
    assert audio_response.status_code == 200, audio_response.text
    assert audio_response.content == FULL_MIX_BYTES
    assert manifest["audio"]["bytes"] == len(FULL_MIX_BYTES)
    assert manifest["audio"]["sha256"] == hashlib.sha256(FULL_MIX_BYTES).hexdigest()
    expected_revision = hashlib.sha256(
        bytes.fromhex(manifest["chart"]["sha256"])
        + bytes.fromhex(manifest["audio"]["sha256"])
    ).hexdigest()
    assert manifest["revision"] == expected_revision

    range_response = client.get(
        manifest["audio"]["url"], headers={"Range": "bytes=5-12"}
    )
    assert range_response.status_code == 206, range_response.text
    assert range_response.content == FULL_MIX_BYTES[5:13]
    assert range_response.headers["content-range"] == (
        f"bytes 5-12/{len(FULL_MIX_BYTES)}"
    )


@pytest.mark.parametrize(("arrangement", "has_templates"), [(0, False), (1, True)])
def test_chart_preserves_one_canonical_chord_template_frame(
    package_client, arrangement, has_templates
):
    client, dlc = package_client
    filename = f"templates-{arrangement}.sloppak"
    _write_pack(dlc, filename)

    response = client.get("/api/practice-package/chart", params={
        "filename": filename,
        "arrangement": arrangement,
    })
    assert response.status_code == 200, response.text
    messages = [json.loads(line) for line in response.content.splitlines()]
    templates = [message for message in messages if message["type"] == "chord_templates"]
    assert len(templates) == 1
    assert bool(templates[0]["data"]) is has_templates


def test_single_reserved_full_stem_is_a_complete_mix(package_client):
    client, dlc = package_client
    filename = "single-full.feedpak"
    _write_pack(dlc, filename, stems=[{
        "id": "full", "file": "stems/full.ogg", "default": True,
    }])

    response = client.get(
        "/api/practice-package/manifest", params={"filename": filename}
    )
    assert response.status_code == 200, response.text
    assert response.json()["audio"] == {
        "url": "/api/sloppak/single-full.feedpak/file/stems/full.ogg",
        "bytes": len(FULL_MIX_BYTES),
        "sha256": hashlib.sha256(FULL_MIX_BYTES).hexdigest(),
    }


def test_unclassified_arrangement_uses_legacy_manifest_name(package_client):
    client, dlc = package_client
    filename = "unclassified.feedpak"
    _write_pack(
        dlc,
        filename,
        stems=[{"id": "full", "file": "stems/full.ogg", "default": True}],
        arrangements=[("Diagnostic", False)],
    )

    response = client.get("/api/practice-package/manifest", params={
        "filename": filename,
        "arrangement": 0,
        "naming_mode": "smart",
    })
    assert response.status_code == 200, response.text
    manifest = response.json()
    assert manifest["arrangement"]["name"] == "Diagnostic"
    assert manifest["arrangement"]["smart_name"] == "Diagnostic"

    chart_response = client.get(manifest["chart"]["url"])
    assert chart_response.status_code == 200, chart_response.text
    canonical = _canonical_messages(
        filename, arrangement=0, naming_mode="smart"
    )
    canonical_chart = b"".join(
        practice_package_mod.compact_json_bytes(message) + b"\n"
        for message in canonical
    )
    assert chart_response.content == canonical_chart
    assert canonical[0]["arrangement_smart_name"] is None


def test_instrument_stems_without_complete_mix_are_rejected(package_client):
    client, dlc = package_client
    filename = "instruments-only.sloppak"
    _write_pack(dlc, filename, stems=[
        {"id": "guitar", "file": "stems/guitar.ogg", "default": True},
        {"id": "drums", "file": "stems/drums.ogg", "default": True},
    ])

    response = client.get(
        "/api/practice-package/manifest", params={"filename": filename}
    )
    assert response.status_code == 422
    assert response.json() == {
        "detail": "Practice package source has no complete mix"
    }


def test_source_failures_are_stable_and_non_leaking(package_client):
    client, dlc = package_client
    (dlc / "unsupported.zip").write_bytes(b"not a package")
    loose = dlc / "loose-song"
    loose.mkdir()
    (loose / "audio.wem").write_bytes(b"RIFF")
    (loose / "lead.xml").write_text("<song/>", encoding="utf-8")
    _write_pack(dlc, "no-arrangements.sloppak", arrangements=[])

    cases = [
        ("missing.sloppak", 404, "Practice package source was not found"),
        ("../outside.sloppak", 403, "Practice package source is forbidden"),
        (
            "unsupported.zip",
            400,
            "Practice packages require a local .feedpak or .sloppak source",
        ),
        (
            "loose-song",
            400,
            "Practice packages require a local .feedpak or .sloppak source",
        ),
        (
            "no-arrangements.sloppak",
            422,
            "Practice package source has no arrangements",
        ),
    ]
    for filename, status, detail in cases:
        response = client.get(
            "/api/practice-package/manifest", params={"filename": filename}
        )
        assert response.status_code == status, (filename, response.text)
        assert response.json() == {"detail": detail}
        assert str(dlc) not in response.text


def test_malformed_canonical_output_returns_stable_500(package_client, monkeypatch):
    client, _dlc = package_client

    async def malformed_snapshot(*args, emit, **kwargs):
        await emit({"type": "ready"})

    monkeypatch.setattr(
        practice_package_mod, "stream_highway_snapshot", malformed_snapshot
    )
    response = client.get(
        "/api/practice-package/chart", params={"filename": "song.sloppak"}
    )
    assert response.status_code == 500
    assert response.json() == {"detail": "Canonical chart output is malformed"}


def test_chart_size_limit_returns_413(package_client, monkeypatch):
    client, _dlc = package_client
    assert practice_package_mod.PRACTICE_PACKAGE_CHART_MAX_BYTES == 32 * 1024 * 1024

    async def oversized_snapshot(*args, emit, **kwargs):
        await emit({"type": "song_info", "padding": "x" * 128})

    monkeypatch.setattr(
        practice_package_mod, "stream_highway_snapshot", oversized_snapshot
    )
    monkeypatch.setattr(practice_package_mod, "PRACTICE_PACKAGE_CHART_MAX_BYTES", 64)
    response = client.get(
        "/api/practice-package/chart", params={"filename": "song.sloppak"}
    )
    assert response.status_code == 413
    assert response.json() == {
        "detail": "Canonical chart exceeds the 32 MiB limit"
    }


def test_chart_route_does_not_resolve_or_hash_audio(package_client, monkeypatch):
    client, dlc = package_client
    filename = "chart-only.sloppak"
    _write_pack(dlc, filename)

    def unexpected_audio_work(*args, **kwargs):
        raise AssertionError("chart route must not inspect audio bytes")

    monkeypatch.setattr(
        practice_package_router, "_resolve_sloppak_local_file", unexpected_audio_work
    )
    monkeypatch.setattr(practice_package_mod, "_hash_file", unexpected_audio_work)
    response = client.get(
        "/api/practice-package/chart", params={"filename": filename}
    )
    assert response.status_code == 200, response.text
    assert response.content.endswith(b"\n")


def test_unexpected_snapshot_exception_propagates(package_client, monkeypatch):
    client, _dlc = package_client

    async def unexpected_snapshot_failure(*args, **kwargs):
        raise RuntimeError("snapshot exploded")

    monkeypatch.setattr(
        practice_package_mod,
        "stream_highway_snapshot",
        unexpected_snapshot_failure,
    )
    with pytest.raises(RuntimeError, match="snapshot exploded"):
        client.get(
            "/api/practice-package/chart", params={"filename": "song.sloppak"}
        )


def test_selected_drum_part_identity_and_query_are_pinned(tmp_path, monkeypatch):
    audio_file = tmp_path / "full.ogg"
    audio_file.write_bytes(FULL_MIX_BYTES)
    captured = {}

    async def drum_snapshot(
        filename, arrangement, naming_mode, drum_part, *, emit, progress=None
    ):
        captured.update({
            "filename": filename,
            "arrangement": arrangement,
            "naming_mode": naming_mode,
            "drum_part": drum_part,
        })
        await emit({
            "type": "song_info",
            "title": "Drum Song",
            "artist": "Drummer",
            "duration": 10.0,
            "arrangement": "Lead",
            "arrangement_smart_name": "Lead",
            "arrangement_index": 0,
            "naming_mode": "smart",
            "drum_parts": [
                {"id": "studio", "name": "Studio"},
                {"id": "live", "name": "Live"},
            ],
            "stems": [],
            "full_mix_url": "/api/sloppak/drums.sloppak/file/stems/full.ogg",
        })
        await emit({"type": "drum_tab", "part_id": "live"})
        await emit({"type": "ready"})

    monkeypatch.setattr(practice_package_mod, "stream_highway_snapshot", drum_snapshot)

    def resolve(filename, rel_path):
        assert (filename, rel_path) == ("drums.sloppak", "stems/full.ogg")
        return audio_file

    package = asyncio.run(practice_package_mod.build_practice_package(
        "drums.sloppak",
        arrangement=0,
        naming_mode="smart",
        drum_part="live",
        resolve_audio_file=resolve,
    ))
    assert captured == {
        "filename": "drums.sloppak",
        "arrangement": 0,
        "naming_mode": "smart",
        "drum_part": "live",
    }
    assert package.manifest["arrangement"]["drum_part"] == {
        "id": "live", "name": "Live",
    }
    assert "drum_part=live" in package.manifest["chart"]["url"]
