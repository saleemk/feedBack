"""WebSocket transport adapter for canonical highway snapshots."""

import asyncio
import json
import logging
import uuid

import structlog
from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from highway_snapshot import (
    HighwaySnapshotError,
    _drum_part_id_for_wire,
    _pick_smart_arrangement,
    _sanitize_authors,
    _sanitized_song_offset,
    stream_highway_snapshot,
)

log = logging.getLogger("feedBack.server")
router = APIRouter()


@router.websocket("/ws/highway/{filename:path}")
async def highway_ws(
    websocket: WebSocket,
    filename: str,
    arrangement: int = -1,
    naming_mode: str = "legacy",
    drum_part: str = "",
):
    """Stream one canonical highway snapshot, then retain the control channel."""
    await websocket.accept()
    structlog.contextvars.bind_contextvars(ws_conn_id=uuid.uuid4().hex[:8])

    keepalive_active = False
    keepalive_task = None

    async def _send_keepalives():
        while keepalive_active:
            try:
                await asyncio.sleep(3)
                if keepalive_active:
                    await websocket.send_json({"type": "loading", "stage": "Loading..."})
            except Exception:
                break

    async def _progress(stage: str | None) -> None:
        nonlocal keepalive_active, keepalive_task
        if stage is None:
            keepalive_active = False
            if keepalive_task is not None:
                keepalive_task.cancel()
                keepalive_task = None
            return

        await websocket.send_json({"type": "loading", "stage": stage})
        if stage == "Extracting...":
            keepalive_active = True
            keepalive_task = asyncio.create_task(_send_keepalives())

    try:
        await stream_highway_snapshot(
            filename,
            arrangement=arrangement,
            naming_mode=naming_mode,
            drum_part=drum_part,
            emit=websocket.send_json,
            progress=_progress,
        )

        # Keep connection alive for control messages.
        try:
            while True:
                msg = await websocket.receive_text()
                data = json.loads(msg)
                if data.get("action") == "change_arrangement":
                    pass
        except WebSocketDisconnect:
            pass
    except HighwaySnapshotError as exc:
        try:
            await websocket.send_json({"error": str(exc)})
            await websocket.close()
        except WebSocketDisconnect:
            return
    except WebSocketDisconnect:
        # Navigating away during loading or streaming is routine.
        return
    except Exception as exc:
        log.exception("highway_ws unhandled error for %s", filename)
        try:
            await websocket.send_json({"error": str(exc)})
            await websocket.close()
        except Exception:
            pass
    finally:
        keepalive_active = False
        if keepalive_task is not None:
            keepalive_task.cancel()
