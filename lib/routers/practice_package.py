"""Read-only HTTP endpoints for V1 downloadable practice packages."""

from fastapi import APIRouter, HTTPException, Response

import practice_package as practice_package_mod
from routers.media import _resolve_sloppak_local_file


router = APIRouter()

_ERROR_STATUS = {
    "source_forbidden": 403,
    "source_not_found": 404,
    "unsupported_source": 400,
    "no_arrangements": 422,
    "invalid_source": 422,
    "complete_mix_required": 422,
    "malformed_snapshot": 500,
    "chart_too_large": 413,
    "audio_forbidden": 403,
    "audio_not_found": 404,
}


async def _map_errors(awaitable):
    try:
        return await awaitable
    except practice_package_mod.PracticePackageError as exc:
        raise HTTPException(
            status_code=_ERROR_STATUS.get(exc.code, 500), detail=exc.message
        ) from None


@router.get("/api/practice-package/manifest")
async def practice_package_manifest(
    filename: str,
    arrangement: int = -1,
    naming_mode: str = "legacy",
    drum_part: str = "",
):
    package = await _map_errors(practice_package_mod.build_practice_package(
        filename,
        arrangement=arrangement,
        naming_mode=naming_mode,
        drum_part=drum_part,
        resolve_audio_file=_resolve_sloppak_local_file,
    ))
    return Response(
        content=practice_package_mod.compact_json_bytes(package.manifest),
        media_type="application/json",
    )


@router.get("/api/practice-package/chart")
async def practice_package_chart(
    filename: str,
    arrangement: int = -1,
    naming_mode: str = "legacy",
    drum_part: str = "",
):
    chart = await _map_errors(practice_package_mod.build_practice_chart(
        filename,
        arrangement=arrangement,
        naming_mode=naming_mode,
        drum_part=drum_part,
    ))
    return Response(
        content=chart.chart,
        media_type=practice_package_mod.PRACTICE_PACKAGE_CHART_MEDIA_TYPE,
    )
