"""Transport-neutral construction of downloadable practice-package artifacts."""

from __future__ import annotations

import asyncio
import hashlib
import json
import math
from dataclasses import dataclass
from pathlib import Path
from typing import Callable
from urllib.parse import unquote, urlencode, urlsplit

import sloppak as sloppak_mod
from highway_snapshot import HighwaySnapshotError, stream_highway_snapshot


PRACTICE_PACKAGE_MANIFEST_SCHEMA = "feedback.practice-package.manifest.v1"
PRACTICE_PACKAGE_CHART_MEDIA_TYPE = "application/x-ndjson"
PRACTICE_PACKAGE_CHART_MAX_BYTES = 32 * 1024 * 1024

AudioResolver = Callable[[str, str], Path | tuple[str, int]]


class PracticePackageError(Exception):
    """An expected package-construction failure with a stable public code."""

    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


@dataclass(frozen=True)
class PracticeChart:
    chart: bytes
    song_info: dict
    selected_drum_part: dict | None
    audio_url: str
    audio_filename: str
    audio_rel_path: str


@dataclass(frozen=True)
class PracticePackage:
    manifest: dict
    chart: bytes


def compact_json_bytes(value) -> bytes:
    """Serialize deterministic compact UTF-8 JSON without non-finite numbers."""
    return json.dumps(
        value,
        allow_nan=False,
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
    ).encode("utf-8")


def _error(code: str, message: str) -> PracticePackageError:
    return PracticePackageError(code, message)


def _malformed() -> PracticePackageError:
    return _error("malformed_snapshot", "Canonical chart output is malformed")


def _public_snapshot_error(exc: HighwaySnapshotError) -> PracticePackageError:
    message = str(exc)
    if message == "forbidden":
        return _error("source_forbidden", "Practice package source is forbidden")
    if message in {"File not found", "DLC folder not configured"}:
        return _error("source_not_found", "Practice package source was not found")
    if message == "No arrangements found":
        return _error("no_arrangements", "Practice package source has no arrangements")
    return _error("invalid_source", "Practice package source could not be loaded")


def _validate_song_info(message: dict) -> None:
    if not isinstance(message.get("title"), str):
        raise _malformed()
    if not isinstance(message.get("artist"), str):
        raise _malformed()
    duration = message.get("duration")
    if (
        not isinstance(duration, (int, float))
        or isinstance(duration, bool)
        or not math.isfinite(duration)
        or duration < 0
    ):
        raise _malformed()
    arrangement_index = message.get("arrangement_index")
    if (
        not isinstance(arrangement_index, int)
        or isinstance(arrangement_index, bool)
        or arrangement_index < 0
    ):
        raise _malformed()
    if not isinstance(message.get("arrangement"), str):
        raise _malformed()
    if not isinstance(message.get("arrangement_smart_name"), str):
        raise _malformed()
    if message.get("naming_mode") not in {"legacy", "smart"}:
        raise _malformed()


def _selected_drum_part(song_info: dict, selected_id: str | None) -> dict | None:
    raw_parts = song_info.get("drum_parts", [])
    if not isinstance(raw_parts, list):
        raise _malformed()

    parts = []
    for part in raw_parts:
        if not isinstance(part, dict):
            raise _malformed()
        part_id = part.get("id")
        part_name = part.get("name")
        if not isinstance(part_id, str) or not isinstance(part_name, str):
            raise _malformed()
        parts.append({"id": part_id, "name": part_name})

    if selected_id is None and len(parts) == 1:
        return parts[0]
    if selected_id is not None:
        for part in parts:
            if part["id"] == selected_id:
                return part
        raise _malformed()
    return None


def _complete_mix_url(song_info: dict) -> str:
    full_mix_url = song_info.get("full_mix_url")
    if isinstance(full_mix_url, str) and full_mix_url:
        return full_mix_url

    stems = song_info.get("stems")
    if (
        isinstance(stems, list)
        and len(stems) == 1
        and isinstance(stems[0], dict)
        and stems[0].get("id") == sloppak_mod.FULL_MIX_STEM_ID
        and isinstance(stems[0].get("url"), str)
        and stems[0]["url"]
    ):
        return stems[0]["url"]
    raise _error(
        "complete_mix_required", "Practice package source has no complete mix"
    )


def _parse_contained_audio_url(url: str, filename: str) -> tuple[str, str]:
    parsed = urlsplit(url)
    if parsed.scheme or parsed.netloc or parsed.query or parsed.fragment:
        raise _malformed()

    prefix = "/api/sloppak/"
    separator = "/file/"
    if not parsed.path.startswith(prefix):
        raise _malformed()
    encoded_filename, found, encoded_rel_path = parsed.path[len(prefix):].partition(
        separator
    )
    if not found or not encoded_filename or not encoded_rel_path:
        raise _malformed()
    try:
        decoded_filename = unquote(encoded_filename, errors="strict")
        rel_path = unquote(encoded_rel_path, errors="strict")
    except UnicodeDecodeError as exc:
        raise _malformed() from exc
    if decoded_filename != filename:
        raise _malformed()
    return decoded_filename, rel_path


def _hash_file(path: Path) -> tuple[int, str]:
    digest = hashlib.sha256()
    byte_count = 0
    with path.open("rb") as source:
        while chunk := source.read(1024 * 1024):
            byte_count += len(chunk)
            digest.update(chunk)
    return byte_count, digest.hexdigest()


async def build_practice_chart(
    filename: str,
    arrangement: int = -1,
    naming_mode: str = "legacy",
    drum_part: str = "",
    *,
    max_chart_bytes: int | None = None,
) -> PracticeChart:
    """Build and validate one bounded canonical NDJSON chart."""
    if not filename.lower().endswith(sloppak_mod.SONG_EXTS):
        raise _error(
            "unsupported_source",
            "Practice packages require a local .feedpak or .sloppak source",
        )

    limit = (
        PRACTICE_PACKAGE_CHART_MAX_BYTES
        if max_chart_bytes is None
        else max_chart_bytes
    )
    chart = bytearray()
    first_message = None
    last_message = None
    selected_drum_part_id = None

    async def collect(message: dict) -> None:
        nonlocal first_message, last_message, selected_drum_part_id
        if not isinstance(message, dict):
            raise _malformed()
        try:
            line = compact_json_bytes(message) + b"\n"
        except (TypeError, ValueError) as exc:
            raise _malformed() from exc
        if len(chart) + len(line) > limit:
            raise _error(
                "chart_too_large", "Canonical chart exceeds the 32 MiB limit"
            )
        if first_message is None:
            first_message = message
        last_message = message
        part_id = message.get("part_id") if message.get("type") == "drum_tab" else None
        if part_id is not None:
            if not isinstance(part_id, str) or selected_drum_part_id is not None:
                raise _malformed()
            selected_drum_part_id = part_id
        chart.extend(line)

    try:
        await stream_highway_snapshot(
            filename,
            arrangement=arrangement,
            naming_mode=naming_mode,
            drum_part=drum_part,
            emit=collect,
        )
    except PracticePackageError:
        raise
    except HighwaySnapshotError as exc:
        raise _public_snapshot_error(exc) from exc
    except ValueError as exc:
        if str(exc) == "Unsupported song format":
            raise _error(
                "unsupported_source",
                "Practice packages require a local .feedpak or .sloppak source",
            ) from exc
        raise

    if (
        not isinstance(first_message, dict)
        or first_message.get("type") != "song_info"
        or not isinstance(last_message, dict)
        or last_message.get("type") != "ready"
    ):
        raise _malformed()
    _validate_song_info(first_message)
    selected_drum_part = _selected_drum_part(
        first_message, selected_drum_part_id
    )
    audio_url = _complete_mix_url(first_message)
    audio_filename, rel_path = _parse_contained_audio_url(audio_url, filename)
    return PracticeChart(
        chart=bytes(chart),
        song_info=first_message,
        selected_drum_part=selected_drum_part,
        audio_url=audio_url,
        audio_filename=audio_filename,
        audio_rel_path=rel_path,
    )


async def build_practice_package(
    filename: str,
    arrangement: int = -1,
    naming_mode: str = "legacy",
    drum_part: str = "",
    *,
    resolve_audio_file: AudioResolver,
    max_chart_bytes: int | None = None,
) -> PracticePackage:
    """Build one deterministic manifest and its canonical NDJSON chart."""
    practice_chart = await build_practice_chart(
        filename,
        arrangement=arrangement,
        naming_mode=naming_mode,
        drum_part=drum_part,
        max_chart_bytes=max_chart_bytes,
    )
    resolved_audio = resolve_audio_file(
        practice_chart.audio_filename, practice_chart.audio_rel_path
    )
    if isinstance(resolved_audio, tuple):
        error, status = resolved_audio
        if status == 403 or error == "forbidden":
            raise _error("audio_forbidden", "Practice package audio is forbidden")
        raise _error("audio_not_found", "Practice package audio was not found")

    try:
        audio_bytes, audio_sha256 = await asyncio.to_thread(
            _hash_file, Path(resolved_audio)
        )
    except OSError as exc:
        raise _error("audio_not_found", "Practice package audio was not found") from exc

    chart_bytes = practice_chart.chart
    chart_sha256 = hashlib.sha256(chart_bytes).hexdigest()
    revision = hashlib.sha256(
        bytes.fromhex(chart_sha256) + bytes.fromhex(audio_sha256)
    ).hexdigest()
    song_info = practice_chart.song_info
    selected_drum_part = practice_chart.selected_drum_part
    resolved_arrangement = song_info["arrangement_index"]
    resolved_naming_mode = song_info["naming_mode"]
    resolved_drum_part = selected_drum_part["id"] if selected_drum_part else ""
    chart_url = "/api/practice-package/chart?" + urlencode({
        "filename": filename,
        "arrangement": resolved_arrangement,
        "naming_mode": resolved_naming_mode,
        "drum_part": resolved_drum_part,
    })

    manifest = {
        "schema": PRACTICE_PACKAGE_MANIFEST_SCHEMA,
        "revision": revision,
        "source": {"filename": filename},
        "song": {
            "title": song_info["title"],
            "artist": song_info["artist"],
            "duration": song_info["duration"],
        },
        "arrangement": {
            "index": resolved_arrangement,
            "name": song_info["arrangement"],
            "smart_name": song_info["arrangement_smart_name"],
            "naming_mode": resolved_naming_mode,
            "drum_part": selected_drum_part,
        },
        "chart": {
            "url": chart_url,
            "media_type": PRACTICE_PACKAGE_CHART_MEDIA_TYPE,
            "bytes": len(chart_bytes),
            "sha256": chart_sha256,
        },
        "audio": {
            "url": practice_chart.audio_url,
            "bytes": audio_bytes,
            "sha256": audio_sha256,
        },
    }
    return PracticePackage(manifest=manifest, chart=chart_bytes)
