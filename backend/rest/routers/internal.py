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


class ProjectUsageItem(BaseModel):
    project_id: str
    trace_count: int
    span_count: int
    total_events: int


class UsageByProjectResponse(BaseModel):
    projects: list[ProjectUsageItem]


@router.get(
    "/usage/by-project",
    response_model=UsageByProjectResponse,
    dependencies=[Depends(verify_internal_secret)],
)
async def get_usage_by_project(
    start: datetime = Query(..., description="Start of interval (ISO format)"),
    end: datetime = Query(..., description="End of interval (ISO format)"),
) -> UsageByProjectResponse:
    """Get usage counts (traces + spans) per project for a time interval."""
    ch = get_clickhouse_client()

    # Query traces count per project
    traces_result = ch.query(
        """
        SELECT
            project_id,
            count(*) as count
        FROM traces
        WHERE ch_create_time >= {start:DateTime64(3)}
          AND ch_create_time < {end:DateTime64(3)}
        GROUP BY project_id
        """,
        parameters={"start": start.isoformat(), "end": end.isoformat()},
    )

    traces_by_project: dict[str, int] = {}
    for row in traces_result.result_rows:
        traces_by_project[row[0]] = int(row[1])

    # Query spans count per project
    spans_result = ch.query(
        """
        SELECT
            project_id,
            count(*) as count
        FROM spans
        WHERE ch_create_time >= {start:DateTime64(3)}
          AND ch_create_time < {end:DateTime64(3)}
        GROUP BY project_id
        """,
        parameters={"start": start.isoformat(), "end": end.isoformat()},
    )

    spans_by_project: dict[str, int] = {}
    for row in spans_result.result_rows:
        spans_by_project[row[0]] = int(row[1])

    # Combine results
    all_projects = set(traces_by_project.keys()) | set(spans_by_project.keys())
    projects = []

    for project_id in all_projects:
        trace_count = traces_by_project.get(project_id, 0)
        span_count = spans_by_project.get(project_id, 0)
        projects.append(
            ProjectUsageItem(
                project_id=project_id,
                trace_count=trace_count,
                span_count=span_count,
                total_events=trace_count + span_count,
            )
        )

    return UsageByProjectResponse(projects=projects)


class UsageTotalResponse(BaseModel):
    total_events: int


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

    result = ch.query(
        """
        SELECT count(*) as total
        FROM (
            SELECT 1 FROM traces
            WHERE project_id IN {project_ids:Array(String)}
              AND ch_create_time >= {start:DateTime64(3)}
              AND ch_create_time < {end:DateTime64(3)}
            UNION ALL
            SELECT 1 FROM spans
            WHERE project_id IN {project_ids:Array(String)}
              AND ch_create_time >= {start:DateTime64(3)}
              AND ch_create_time < {end:DateTime64(3)}
        )
        """,
        parameters={
            "project_ids": project_id_list,
            "start": start.isoformat(),
            "end": end.isoformat(),
        },
    )

    total = int(result.result_rows[0][0]) if result.result_rows else 0
    return UsageTotalResponse(total_events=total)
