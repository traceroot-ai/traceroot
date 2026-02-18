"""Internal API endpoints for worker/service communication.

These endpoints are protected by X-Internal-Secret header and not exposed publicly.
"""

from datetime import datetime
from typing import Annotated

from fastapi import APIRouter, Depends, Header, HTTPException, Query
from pydantic import BaseModel

from db.clickhouse.client import get_clickhouse_client
from shared.config import settings

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
