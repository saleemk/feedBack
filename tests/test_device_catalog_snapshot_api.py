"""Focused contract tests for GET /api/library/device-catalog."""

import hashlib
import importlib
import re
import sqlite3
import sys

import pytest
from fastapi.testclient import TestClient


@pytest.fixture()
def server(tmp_path, monkeypatch, isolate_logging):
    monkeypatch.setenv("CONFIG_DIR", str(tmp_path))
    monkeypatch.setenv("FEEDBACK_SKIP_STARTUP_TASKS", "1")
    sys.modules.pop("server", None)
    srv = importlib.import_module("server")
    try:
        yield srv
    finally:
        conn = getattr(getattr(srv, "meta_db", None), "conn", None)
        if conn is not None:
            getattr(sys.modules.get("server"), "_join_background_db_threads", lambda: None)()
            conn.close()
        sys.modules.pop("server", None)


@pytest.fixture()
def client(server):
    return TestClient(server.app)


@pytest.fixture()
def library_router(server):
    return importlib.import_module("routers.library")


def _seed(server, filename, title="Song", artist="Artist"):
    server.meta_db.put(filename, 0, 0, {"title": title, "artist": artist})


def _snapshot(client):
    response = client.get("/api/library/device-catalog")
    assert response.status_code == 200
    return response.json()


def test_empty_snapshot_has_exact_contract(client):
    body = _snapshot(client)

    assert set(body) == {"schema", "source", "revision", "count", "total", "songs"}
    assert body == {
        "schema": "feedback.device-catalog.snapshot.v1",
        "source": "local",
        "revision": hashlib.sha256(b"[]").hexdigest(),
        "count": 0,
        "total": 0,
        "songs": [],
    }


def test_ids_are_private_deterministic_hashes_in_opaque_id_order(client, server):
    filenames = [
        r"C:\Users\listener\Music\z-song.archive",
        r"D:\private-library\a-song.archive",
    ]
    for index, filename in enumerate(filenames):
        _seed(server, filename, title=f"Song {index}", artist=f"Artist {index}")

    first_response = client.get("/api/library/device-catalog")
    second_response = client.get("/api/library/device-catalog")
    body = first_response.json()
    ids = [song["id"] for song in body["songs"]]
    expected_ids = sorted(hashlib.sha256(name.encode("utf-8")).hexdigest() for name in filenames)

    assert first_response.content == second_response.content
    assert ids == expected_ids
    assert len(set(ids)) == len(filenames)
    assert all(re.fullmatch(r"[0-9a-f]{64}", song_id) for song_id in ids)
    assert body["count"] == body["total"] == len(filenames)
    assert all(set(song) == {"id", "title", "artist"} for song in body["songs"])
    assert not any(filename in first_response.text for filename in filenames)
    assert "private-library" not in first_response.text
    assert "C:\\Users\\listener" not in first_response.text

    normal = client.get("/api/library", params={"size": 100}).json()
    assert {song["filename"] for song in normal["songs"]} == set(filenames)


def test_revision_changes_for_title_artist_and_membership(client, server):
    _seed(server, "song-a.archive", title="Original", artist="First")
    original = _snapshot(client)["revision"]
    assert _snapshot(client)["revision"] == original

    server.meta_db.conn.execute(
        "UPDATE songs SET title = ? WHERE filename = ?", ("Changed", "song-a.archive")
    )
    server.meta_db.conn.commit()
    title_changed = _snapshot(client)["revision"]
    assert title_changed != original

    server.meta_db.conn.execute(
        "UPDATE songs SET artist = ? WHERE filename = ?", ("Second", "song-a.archive")
    )
    server.meta_db.conn.commit()
    artist_changed = _snapshot(client)["revision"]
    assert artist_changed != title_changed

    _seed(server, "song-b.archive", title="Another", artist="Third")
    assert _snapshot(client)["revision"] != artist_changed


def test_text_is_trimmed_bounded_and_normalized_before_revision(
    client, server, library_router
):
    title = "T" * (library_router.DEVICE_CATALOG_SNAPSHOT_TITLE_MAX_CHARS + 20)
    artist = "A" * (library_router.DEVICE_CATALOG_SNAPSHOT_ARTIST_MAX_CHARS + 20)
    _seed(server, "song.archive", title=f"  {title}  ", artist=f"\t{artist}\n")

    first = _snapshot(client)
    song = first["songs"][0]
    assert song["title"] == "T" * library_router.DEVICE_CATALOG_SNAPSHOT_TITLE_MAX_CHARS
    assert song["artist"] == "A" * library_router.DEVICE_CATALOG_SNAPSHOT_ARTIST_MAX_CHARS

    server.meta_db.conn.execute(
        "UPDATE songs SET title = ?, artist = ? WHERE filename = ?",
        (
            song["title"] + "different discarded suffix",
            song["artist"] + "another discarded suffix",
            "song.archive",
        ),
    )
    server.meta_db.conn.commit()
    assert _snapshot(client)["revision"] == first["revision"]

    server.meta_db.conn.execute(
        "UPDATE songs SET title = ?, artist = NULL WHERE filename = ?",
        (sqlite3.Binary(b"not text"), "song.archive"),
    )
    server.meta_db.conn.commit()
    normalized = _snapshot(client)["songs"][0]
    assert normalized["title"] == ""
    assert normalized["artist"] == ""


def test_record_limit_returns_413_without_partial_snapshot(
    client, server, library_router, monkeypatch
):
    monkeypatch.setattr(library_router, "DEVICE_CATALOG_SNAPSHOT_MAX_RECORDS", 2)
    for index in range(3):
        _seed(server, f"song-{index}.archive")

    requested_limits = []
    original = server.meta_db.device_catalog_snapshot_rows

    def recording_read(limit):
        requested_limits.append(limit)
        return original(limit)

    monkeypatch.setattr(server.meta_db, "device_catalog_snapshot_rows", recording_read)
    response = client.get("/api/library/device-catalog")

    assert response.status_code == 413
    assert requested_limits == [3]
    assert set(response.json()) == {"detail"}
    assert "record limit" in response.json()["detail"]


def test_byte_limit_returns_413_without_partial_snapshot(
    client, server, library_router, monkeypatch
):
    assert library_router.DEVICE_CATALOG_SNAPSHOT_MAX_BYTES == 2 * 1024 * 1024
    _seed(server, "song.archive", title="A title", artist="An artist")
    monkeypatch.setattr(library_router, "DEVICE_CATALOG_SNAPSHOT_MAX_BYTES", 64)

    response = client.get("/api/library/device-catalog")

    assert response.status_code == 413
    assert set(response.json()) == {"detail"}
    assert "byte limit" in response.json()["detail"]
