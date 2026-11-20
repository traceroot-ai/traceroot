"""Project-level trace reads for the web app."""

from datetime import UTC

from fastapi import APIRouter, Depends

from rest.routers.internal.auth import verify_internal_secret
from rest.services.trace_reader import get_trace_reader_service

router = APIRouter()


@router.get(
    "/projects/{project_id}/first-trace",
    dependencies=[Depends(verify_internal_secret)],
)
async def get_first_trace(project_id: str) -> dict[str, str | None]:
    """Report when a project first received a trace that is still stored.

    The web app compares it with the moment it started recording first traces, to
    tell a project that already had traces from one receiving its first, and fills
    ``projects.first_trace_receive_time`` from it.

    Args:
        project_id (str): Project whose customer spans to read.

    Returns:
        dict: ``{"first_trace_receive_time": str | None}``: the ISO-8601 UTC time
            the earliest stored customer span was received, or None when the
            project has no customer spans.
    """
    received = get_trace_reader_service().first_trace_receive_time(project_id)
    return {
        "first_trace_receive_time": received.replace(tzinfo=UTC).isoformat() if received else None
    }
