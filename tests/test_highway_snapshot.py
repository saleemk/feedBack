"""Focused contract tests for transport-independent highway snapshots."""

from __future__ import annotations

import asyncio
import json

import pytest
import yaml

import appstate
from highway_snapshot import HighwaySnapshotError, stream_highway_snapshot
from routers.ws_highway import highway_ws


def _note(index: int) -> dict:
    return {"t": index / 10, "s": index % 6, "f": index % 12}


def _chord(index: int) -> dict:
    return {"t": index / 10, "id": 0, "notes": []}


def _handshape(index: int) -> dict:
    return {
        "chord_id": 0,
        "start_time": index / 10,
        "end_time": index / 10 + 0.05,
    }


def _phrase(index: int) -> dict:
    return {
        "start_time": float(index),
        "end_time": float(index + 1),
        "max_difficulty": 0,
        "levels": [],
    }


def _arrangement(*, populated: bool) -> dict:
    return {
        "name": "Rhythm" if populated else "Lead",
        "tuning": [0, 0, 0, 0, 0, 0],
        "capo": 2 if populated else 0,
        "centOffset": -12.5 if populated else 0.0,
        "notes": [_note(i) for i in range(501)] if populated else [],
        "chords": [_chord(i) for i in range(501)] if populated else [],
        "anchors": [{"time": 0.0, "fret": 3, "width": 4}] if populated else [],
        "handshapes": [_handshape(i) for i in range(501)] if populated else [],
        "templates": [
            {
                "name": "Am",
                "displayName": "A minor",
                "frets": [-1, 0, 2, 2, 1, 0],
                "fingers": [-1, 0, 2, 3, 1, 0],
            }
        ] if populated else [],
        "phrases": [_phrase(i) for i in range(21)] if populated else [],
        "beats": [{"time": 9.0, "measure": 9}],
        "sections": [{"name": "arrangement", "number": 9, "time": 9.0}],
    }


def _write_sloppak(dlc, name: str) -> str:
    filename = f"{name}.sloppak"
    pak = dlc / filename
    (pak / "arrangements").mkdir(parents=True)
    (pak / "stems").mkdir()
    (pak / "stems" / "full.ogg").write_bytes(b"full mix")
    (pak / "stems" / "guitar.ogg").write_bytes(b"guitar")
    (pak / "arrangements" / "lead.json").write_text(
        json.dumps(_arrangement(populated=False)), encoding="utf-8"
    )
    (pak / "arrangements" / "rhythm.json").write_text(
        json.dumps(_arrangement(populated=True)), encoding="utf-8"
    )
    (pak / "timeline.json").write_text(json.dumps({
        "version": 1,
        "beats": [{"time": 0.0, "measure": 1}],
        "sections": [{"name": "intro", "number": 1, "time": 0.0}],
        "tempos": [{"time": 0.0, "bpm": 120}],
        "time_signatures": [{"time": 0.0, "ts": [4, 4]}],
    }), encoding="utf-8")
    (pak / "keys.json").write_text(json.dumps({
        "version": 1,
        "events": [{"t": 0.0, "key": "Am", "scale": "natural_minor"}],
    }), encoding="utf-8")
    (pak / "manifest.yaml").write_text(yaml.safe_dump({
        "title": "Snapshot",
        "artist": "Tester",
        "duration": 60.0,
        "song_timeline": "timeline.json",
        "keys": "keys.json",
        "arrangements": [
            {"id": "lead", "name": "Lead", "file": "arrangements/lead.json"},
            {
                "id": "rhythm",
                "name": "Rhythm",
                "file": "arrangements/rhythm.json",
                "capo": 2,
                "centOffset": -12.5,
            },
        ],
        "stems": [
            {"id": "full", "file": "stems/full.ogg", "default": True},
            {"id": "guitar", "file": "stems/guitar.ogg", "default": True},
        ],
    }, sort_keys=False), encoding="utf-8")
    return filename


@pytest.fixture()
def snapshot_env(tmp_path, monkeypatch):
    dlc = tmp_path / "dlc"
    dlc.mkdir()
    monkeypatch.setenv("DLC_DIR", str(dlc))
    monkeypatch.setattr(appstate, "dlc_dir_env", str(dlc))
    monkeypatch.setattr(appstate, "dlc_dir", dlc)
    monkeypatch.setattr(appstate, "sloppak_cache_dir", tmp_path / "sloppak-cache")
    monkeypatch.setattr(appstate, "audio_cache_dir", tmp_path / "audio-cache")
    monkeypatch.setattr(appstate, "static_dir", tmp_path / "static")
    monkeypatch.setattr(appstate, "config_dir", tmp_path / "config")
    return dlc


def _capture(filename: str, **options):
    frames = []
    progress = []

    async def emit(message):
        frames.append(message)

    async def report(stage):
        progress.append(stage)

    asyncio.run(stream_highway_snapshot(
        filename,
        emit=emit,
        progress=report,
        **options,
    ))
    return frames, progress


class _CaptureWebSocket:
    def __init__(self):
        self.messages = []
        self.closed = False

    async def accept(self):
        pass

    async def send_json(self, message):
        self.messages.append(message)

    async def close(self):
        self.closed = True

    async def receive_text(self):
        raise AssertionError("error paths must not enter the control loop")


def test_snapshot_preserves_selected_song_info_order_and_chunking(snapshot_env):
    filename = _write_sloppak(snapshot_env, f"snapshot-{snapshot_env.parent.name}")

    frames, progress = _capture(filename, arrangement=1, naming_mode="smart")
    types = [frame["type"] for frame in frames]

    assert types == [
        "song_info", "beats", "sections", "keys", "tempos",
        "time_signatures", "anchors", "chord_templates",
        "notes", "notes", "chords", "chords",
        "handshapes", "handshapes", "phrases", "phrases", "ready",
    ]
    assert progress == ["Extracting...", None]

    info = frames[0]
    assert info["arrangement"] == "Rhythm"
    assert info["arrangement_index"] == 1
    assert info["arrangement_smart_name"] == "Rhythm"
    assert info["naming_mode"] == "smart"
    assert info["capo"] == 2
    assert info["centOffset"] == -12.5
    assert info["format"] == "sloppak"
    assert info["has_keys"] is True
    assert info["has_notation"] is False
    assert info["has_stems"] is True
    assert info["has_full_mix"] is True
    assert info["stems"] == [{
        "id": "guitar",
        "url": f"/api/sloppak/{filename}/file/stems/guitar.ogg",
        "default": True,
    }]
    assert info["audio_url"] == info["stems"][0]["url"]
    assert info["full_mix_url"] == (
        f"/api/sloppak/{filename}/file/stems/full.ogg"
    )

    templates = [frame for frame in frames if frame["type"] == "chord_templates"]
    assert len(templates) == 1
    assert templates[0]["data"][0]["name"] == "Am"
    for frame_type, expected_sizes in (
        ("notes", [500, 1]),
        ("chords", [500, 1]),
        ("handshapes", [500, 1]),
        ("phrases", [20, 1]),
    ):
        chunks = [frame for frame in frames if frame["type"] == frame_type]
        assert [len(frame["data"]) for frame in chunks] == expected_sizes
        expected_total = 21 if frame_type == "phrases" else 501
        assert all(frame["total"] == expected_total for frame in chunks)


def test_snapshot_emits_one_empty_chord_templates_message(snapshot_env):
    filename = _write_sloppak(snapshot_env, f"empty-template-{snapshot_env.parent.name}")

    frames, _ = _capture(filename, arrangement=0)
    templates = [frame for frame in frames if frame["type"] == "chord_templates"]

    assert templates == [{"type": "chord_templates", "data": []}]
    assert [frame["type"] for frame in frames].index("anchors") < (
        [frame["type"] for frame in frames].index("chord_templates")
    ) < [frame["type"] for frame in frames].index("ready")


def test_snapshot_reports_expected_source_errors(snapshot_env):
    with pytest.raises(HighwaySnapshotError, match="^File not found$"):
        _capture("missing.sloppak")

    unsupported = snapshot_env / "unsupported.zip"
    unsupported.write_bytes(b"not a supported carrier")
    with pytest.raises(ValueError, match="^Unsupported song format$"):
        _capture(unsupported.name)


def test_snapshot_reports_no_arrangements(snapshot_env):
    filename = f"no-arrangements-{snapshot_env.parent.name}.sloppak"
    pak = snapshot_env / filename
    pak.mkdir()
    (pak / "manifest.yaml").write_text(yaml.safe_dump({
        "title": "Empty",
        "artist": "Tester",
        "duration": 1.0,
        "arrangements": [],
        "stems": [],
    }), encoding="utf-8")

    with pytest.raises(HighwaySnapshotError, match="^No arrangements found$"):
        _capture(filename)


@pytest.mark.parametrize(
    ("filename", "expected_error"),
    [
        ("missing.sloppak", "File not found"),
        ("unsupported.zip", "Unsupported song format"),
        ("empty.sloppak", "No arrangements found"),
    ],
)
def test_websocket_preserves_source_error_frames(snapshot_env, filename, expected_error):
    if filename == "unsupported.zip":
        (snapshot_env / filename).write_bytes(b"not a supported carrier")
    elif filename == "empty.sloppak":
        pak = snapshot_env / filename
        pak.mkdir()
        (pak / "manifest.yaml").write_text(yaml.safe_dump({
            "title": "Empty",
            "artist": "Tester",
            "duration": 1.0,
            "arrangements": [],
            "stems": [],
        }), encoding="utf-8")

    websocket = _CaptureWebSocket()
    asyncio.run(highway_ws(websocket, filename))

    assert websocket.messages[-1] == {"error": expected_error}
    assert websocket.closed is True
