"""Internal API endpoints for worker/service communication.

These endpoints are protected by X-Internal-Secret header and not exposed publicly.
"""

import logging
from datetime import UTC, date, datetime, timedelta
from typing import Annotated

from fastapi import APIRouter, Depends, Header, HTTPException, Query
from pydantic import BaseModel, Field

from db.clickhouse.client import get_clickhouse_client
from rest.services.s3 import get_s3_service
from shared.config import settings

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/internal", tags=["internal"])


def verify_internal_secret(
    x_internal_secret: Annotated[str | None, Header()] = None,
) -> None:
    """Verify the internal API secret."""
    if not settings.internal_api_secret:
        # No secret configured, allow all (dev mode)
        return

    if x_internal_secret != settings.internal_api_secret:
        raise HTTPException(status_code=403, detail="Invalid internal secret")


# =============================================================================
# Usage Endpoints (for billing metering)
# =============================================================================


class UsageTotalResponse(BaseModel):
    total_events: int


class UsageDetailsResponse(BaseModel):
    traces: int
    spans: int


@router.get(
    "/usage/total",
    response_model=UsageTotalResponse,
    dependencies=[Depends(verify_internal_secret)],
)
async def get_usage_total(
    project_ids: str = Query(..., description="Comma-separated list of project IDs"),
    start: datetime = Query(..., description="Start of interval (ISO format)"),
    end: datetime = Query(..., description="End of interval (ISO format)"),
) -> UsageTotalResponse:
    """Get total usage for specific projects in a time interval."""
    project_id_list = [p.strip() for p in project_ids.split(",") if p.strip()]

    if not project_id_list:
        return UsageTotalResponse(total_events=0)

    ch = get_clickhouse_client()

    # Format datetime without timezone for ClickHouse
    start_str = start.strftime("%Y-%m-%d %H:%M:%S")
    end_str = end.strftime("%Y-%m-%d %H:%M:%S")

    result = ch.query(
        """
        SELECT count(*) as total
        FROM (
            SELECT 1 FROM traces
            WHERE project_id IN {project_ids:Array(String)}
              AND ch_create_time >= {start:String}
              AND ch_create_time < {end:String}
            UNION ALL
            SELECT 1 FROM spans
            WHERE project_id IN {project_ids:Array(String)}
              AND ch_create_time >= {start:String}
              AND ch_create_time < {end:String}
        )
        """,
        parameters={
            "project_ids": project_id_list,
            "start": start_str,
            "end": end_str,
        },
    )

    total = int(result.result_rows[0][0]) if result.result_rows else 0
    return UsageTotalResponse(total_events=total)


@router.get(
    "/usage/details",
    response_model=UsageDetailsResponse,
    dependencies=[Depends(verify_internal_secret)],
)
async def get_usage_details(
    project_ids: str = Query(..., description="Comma-separated list of project IDs"),
    start: datetime = Query(..., description="Start of interval (ISO format)"),
    end: datetime = Query(..., description="End of interval (ISO format)"),
) -> UsageDetailsResponse:
    """Get detailed usage (traces and spans separately) for specific projects."""
    project_id_list = [p.strip() for p in project_ids.split(",") if p.strip()]

    if not project_id_list:
        return UsageDetailsResponse(traces=0, spans=0)

    ch = get_clickhouse_client()

    # Format datetime without timezone for ClickHouse
    start_str = start.strftime("%Y-%m-%d %H:%M:%S")
    end_str = end.strftime("%Y-%m-%d %H:%M:%S")

    # Query traces count
    traces_result = ch.query(
        """
        SELECT count(*) as total
        FROM traces
        WHERE project_id IN {project_ids:Array(String)}
          AND ch_create_time >= {start:String}
          AND ch_create_time < {end:String}
        """,
        parameters={
            "project_ids": project_id_list,
            "start": start_str,
            "end": end_str,
        },
    )

    # Query spans count
    spans_result = ch.query(
        """
        SELECT count(*) as total
        FROM spans
        WHERE project_id IN {project_ids:Array(String)}
          AND ch_create_time >= {start:String}
          AND ch_create_time < {end:String}
        """,
        parameters={
            "project_ids": project_id_list,
            "start": start_str,
            "end": end_str,
        },
    )

    traces = int(traces_result.result_rows[0][0]) if traces_result.result_rows else 0
    spans = int(spans_result.result_rows[0][0]) if spans_result.result_rows else 0

    return UsageDetailsResponse(traces=traces, spans=spans)


# =============================================================================
# Data Retention Endpoints
# =============================================================================


class RetentionCleanupRequest(BaseModel):
    project_ids: list[str] = Field(..., min_length=1)
    ttl_days: int = Field(..., gt=0)


class RetentionCleanupResponse(BaseModel):
    status: str
    project_ids: list[str]
    ttl_days: int
    cutoff_date: str
    s3_objects_deleted: int


def _cleanup_clickhouse(project_ids: list[str], cutoff: datetime) -> None:
    """Submit ALTER TABLE DELETE mutations for traces and spans older than cutoff."""
    ch = get_clickhouse_client()
    cutoff_str = cutoff.strftime("%Y-%m-%d %H:%M:%S")

    ch.command(
        "ALTER TABLE traces DELETE WHERE project_id IN {project_ids:Array(String)}"
        " AND trace_start_time < {cutoff:String}",
        parameters={"project_ids": project_ids, "cutoff": cutoff_str},
    )
    ch.command(
        "ALTER TABLE spans DELETE WHERE project_id IN {project_ids:Array(String)}"
        " AND span_start_time < {cutoff:String}",
        parameters={"project_ids": project_ids, "cutoff": cutoff_str},
    )


_S3_DELETE_BATCH_MAX = 1000  # AWS DeleteObjects limit


def _delete_s3_object_batch(client, bucket: str, batch: list[dict]) -> int:
    """Delete up to 1000 objects; returns count actually deleted (excludes failures)."""
    if not batch:
        return 0
    response = client.delete_objects(
        Bucket=bucket,
        Delete={"Objects": batch, "Quiet": True},
    )
    errors = response.get("Errors", [])
    if errors:
        failed_keys = [e.get("Key", "?") for e in errors]
        logger.warning(
            "S3 delete_objects reported %d failure(s) (sample keys): %s",
            len(errors),
            failed_keys[:3],
        )
    return len(batch) - len(errors)


def _cleanup_s3(project_ids: list[str], cutoff: datetime) -> int:
    """Delete S3 objects for the given projects that are older than cutoff.

    Object key format: events/otel/{project_id}/{yyyy}/{mm}/{dd}/{hh}/{uuid}.json
    Objects are matched by parsing the date components from their key.
    Returns the total number of successfully deleted objects.
    """
    s3 = get_s3_service()
    client = s3._get_client()
    bucket = s3._bucket_name
    cutoff_date = cutoff.date()
    total_deleted = 0

    for project_id in project_ids:
        prefix = f"events/otel/{project_id}/"
        pending: list[dict] = []

        paginator = client.get_paginator("list_objects_v2")
        try:
            for page in paginator.paginate(Bucket=bucket, Prefix=prefix):
                for obj in page.get("Contents", []):
                    key: str = obj["Key"]
                    # Parse: events/otel/{project_id}/{yyyy}/{mm}/{dd}/...
                    parts = key.split("/")
                    if len(parts) >= 6:
                        try:
                            obj_date_str = f"{parts[3]}-{parts[4]}-{parts[5]}"
                            obj_date = date.fromisoformat(obj_date_str)
                            if obj_date < cutoff_date:
                                pending.append({"Key": key})
                                if len(pending) >= _S3_DELETE_BATCH_MAX:
                                    total_deleted += _delete_s3_object_batch(
                                        client,
                                        bucket,
                                        pending[:_S3_DELETE_BATCH_MAX],
                                    )
                                    pending = pending[_S3_DELETE_BATCH_MAX:]
                        except (ValueError, IndexError):
                            pass

            if pending:
                total_deleted += _delete_s3_object_batch(client, bucket, pending)

        except Exception as exc:
            logger.warning("S3 cleanup failed for project %s: %s", project_id, exc, exc_info=True)

    return total_deleted


@router.post(
    "/retention/cleanup",
    response_model=RetentionCleanupResponse,
    dependencies=[Depends(verify_internal_secret)],
)
async def retention_cleanup(
    request: RetentionCleanupRequest,
) -> RetentionCleanupResponse:
    """Delete traces, spans, and raw S3 objects older than ttl_days for the given projects.

    ClickHouse deletions are submitted as asynchronous mutations (ALTER TABLE DELETE)
    and processed by ClickHouse in the background.  S3 object deletions are performed
    synchronously and the count is returned in the response.
    """
    project_ids = [p.strip() for p in request.project_ids if p.strip()]
    if not project_ids:
        raise HTTPException(status_code=422, detail="No valid project IDs provided")

    cutoff = datetime.now(UTC) - timedelta(days=request.ttl_days)

    logger.info(
        "Data retention cleanup: %d project(s), ttl=%d days, cutoff=%s",
        len(project_ids),
        request.ttl_days,
        cutoff.isoformat(),
    )

    _cleanup_clickhouse(project_ids, cutoff)

    s3_deleted = _cleanup_s3(project_ids, cutoff)

    logger.info(
        "Data retention cleanup complete: %d S3 objects deleted for %d project(s)",
        s3_deleted,
        len(project_ids),
    )

    return RetentionCleanupResponse(
        status="ok",
        project_ids=project_ids,
        ttl_days=request.ttl_days,
        cutoff_date=cutoff.isoformat(),
        s3_objects_deleted=s3_deleted,
    )
