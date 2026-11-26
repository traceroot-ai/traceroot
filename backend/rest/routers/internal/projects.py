"""Project-level trace reads and the sample trace, for the web app."""

from datetime import UTC

from fastapi import APIRouter, Depends, HTTPException

from db.clickhouse.client import get_clickhouse_client
from rest.routers.internal.auth import verify_internal_secret
from rest.services.sample_trace import build_sample_trace
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


@router.post(
    "/projects/{project_id}/sample-trace",
    dependencies=[Depends(verify_internal_secret)],
)
def create_sample_trace(project_id: str) -> dict[str, str]:
    """Add the sample trace to a project.

    The rows are inserted directly, not through the ingest queue, so no detector runs
    on them. They are stored as customer traffic, which is what lists them. A project
    that already has traces keeps them, and gets no sample.

    Args:
        project_id (str): Project to add the sample to. The web app has already checked
            the person's access to it.

    Returns:
        dict: ``{"trace_id": str}``, the sample trace.

    Raises:
        HTTPException: 409 when the project already has traces.
    """
    reader = get_trace_reader_service()
    if reader.first_trace_receive_time(project_id) is not None:
        raise HTTPException(status_code=409, detail="This project already has traces")

    trace, spans = build_sample_trace(project_id)
    clickhouse = get_clickhouse_client()
    # Spans first, so a partial failure cannot leave a trace row without its spans.
    clickhouse.insert_spans_batch(spans)
    clickhouse.insert_traces_batch([trace])
    reader.forget_has_traces(project_id)
    return {"trace_id": trace["trace_id"]}
