"""Internal API endpoints for worker/service communication.

These endpoints are protected by X-Internal-Secret header and not exposed publicly.
"""

import hmac
from datetime import datetime
from typing import Annotated

from fastapi import APIRouter, Depends, Header, HTTPException, Query
from pydantic import BaseModel, Field

from db.clickhouse.client import get_clickhouse_client
from rest.schemas.detectors import (
    DetectorCountsResponse,
    FindingListResponse,
    RunListResponse,
)
from rest.sql_utils import escape_ilike, to_utc_naive
from shared.config import settings

router = APIRouter(prefix="/internal", tags=["internal"])


def verify_internal_secret(
    x_internal_secret: Annotated[str | None, Header()] = None,
) -> None:
    """Verify the internal API secret.

    Fails closed: a missing or empty server-side secret rejects all requests
    rather than silently allowing them. (Previous behavior treated an empty
    secret as "dev mode allow-all", which left the new detector write
    endpoints open to anonymous writes whenever the env var was unset.)
    """
    if not settings.internal_api_secret:
        raise HTTPException(
            status_code=503,
            detail="INTERNAL_API_SECRET not configured on server",
        )
    if not x_internal_secret or not hmac.compare_digest(
        x_internal_secret, settings.internal_api_secret
    ):
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
# Detector Endpoints (for worker/TypeScript service writes and reads)
# =============================================================================


class DetectorRunPayload(BaseModel):
    model_config = {"populate_by_name": True}

    run_id: str = Field(alias="runId")
    detector_id: str = Field(alias="detectorId")
    project_id: str = Field(alias="projectId")
    trace_id: str = Field(alias="traceId")
    finding_id: str | None = Field(default=None, alias="findingId")
    status: str


class DetectorFindingPayload(BaseModel):
    model_config = {"populate_by_name": True}

    finding_id: str = Field(alias="findingId")
    project_id: str = Field(alias="projectId")
    trace_id: str = Field(alias="traceId")
    summary: str
    payload: str


@router.post("/detector-runs", dependencies=[Depends(verify_internal_secret)])
async def write_detector_run(body: DetectorRunPayload):
    """Record a detector run result in ClickHouse."""
    ch = get_clickhouse_client()
    ch.query(
        """INSERT INTO detector_runs
           (run_id, detector_id, project_id, trace_id, finding_id, status)
           VALUES ({run_id:String}, {detector_id:String}, {project_id:String},
                   {trace_id:String}, {finding_id:Nullable(String)}, {status:String})""",
        parameters={
            "run_id": body.run_id,
            "detector_id": body.detector_id,
            "project_id": body.project_id,
            "trace_id": body.trace_id,
            "finding_id": body.finding_id,
            "status": body.status,
        },
    )
    return {"ok": True}


@router.post("/detector-findings", dependencies=[Depends(verify_internal_secret)])
async def write_detector_finding(body: DetectorFindingPayload):
    """Record a detector finding in ClickHouse."""
    ch = get_clickhouse_client()
    ch.query(
        """INSERT INTO detector_findings
           (finding_id, project_id, trace_id, summary, payload)
           VALUES ({finding_id:String}, {project_id:String},
                   {trace_id:String}, {summary:String}, {payload:String})""",
        parameters={
            "finding_id": body.finding_id,
            "project_id": body.project_id,
            "trace_id": body.trace_id,
            "summary": body.summary,
            "payload": body.payload,
        },
    )
    return {"ok": True}


@router.get(
    "/detector-runs",
    response_model=RunListResponse,
    dependencies=[Depends(verify_internal_secret)],
)
async def list_detector_runs(
    project_id: str,
    detector_id: str,
    page: int = Query(0, ge=0, description="Page number (0-indexed)"),
    limit: int = Query(50, ge=1, le=200, description="Items per page"),
    start_after: datetime | None = Query(
        None, description="Filter runs at/after this timestamp (inclusive)"
    ),
    end_before: datetime | None = Query(
        None, description="Filter runs strictly before this timestamp"
    ),
    search_query: str | None = Query(
        None, description="Substring match against trace_id OR the per-detector summary"
    ),
):
    """List runs for a detector, newest first.

    Param naming and pagination shape mirror the trace listing endpoints
    (`page`/`limit`/`start_after`/`end_before`/`search_query`) so the same
    `useListPageState` queryOptions can flow through unchanged.

    For triggered runs, JOIN with detector_findings to surface this detector's
    per-detector summary string (the finding's `payload` is the combined
    array of all triggered detectors for the trace; we filter to the entry
    matching this run's detector_id).

    Returns {data: [...], meta: {page, limit, total}}. Total is computed by a
    second COUNT query against the same WHERE clause.
    """
    ch = get_clickhouse_client()
    offset = page * limit

    conditions: list[str] = [
        "r.project_id = {project_id:String}",
        "r.detector_id = {detector_id:String}",
    ]
    params: dict = {
        "project_id": project_id,
        "detector_id": detector_id,
    }

    if start_after is not None:
        conditions.append("r.timestamp >= {start_after:DateTime64(3)}")
        params["start_after"] = to_utc_naive(start_after)

    if end_before is not None:
        conditions.append("r.timestamp < {end_before:DateTime64(3)}")
        params["end_before"] = to_utc_naive(end_before)

    # Per-detector summary expression; reused in WHERE search and SELECT to keep
    # one source of truth for what "the summary for this detector" means.
    summary_expr = (
        "if("
        "  r.finding_id IS NOT NULL,"
        "  JSONExtractString("
        "    arrayFirst("
        "      x -> JSONExtractString(x, 'detectorId') = r.detector_id,"
        "      JSONExtractArrayRaw(f.payload)"
        "    ),"
        "    'summary'"
        "  ),"
        "  ''"
        ")"
    )

    if search_query:
        # ClickHouse ILIKE uses backslash as the default escape character; no
        # ESCAPE clause is supported in the syntax, so we pre-escape `%`/`_`
        # in user input via `escape_ilike`.
        conditions.append(
            f"(r.trace_id ILIKE {{search_kw:String}} OR {summary_expr} ILIKE {{search_kw:String}})"
        )
        params["search_kw"] = f"%{escape_ilike(search_query)}%"

    where_clause = " AND ".join(conditions)

    data_query = f"""
        SELECT
            r.run_id      AS run_id,
            r.detector_id AS detector_id,
            r.project_id  AS project_id,
            r.trace_id    AS trace_id,
            r.finding_id  AS finding_id,
            r.status      AS status,
            r.timestamp   AS timestamp,
            {summary_expr} AS summary
        FROM detector_runs r
        LEFT JOIN detector_findings f
          ON r.finding_id = f.finding_id AND r.project_id = f.project_id
        WHERE {where_clause}
        ORDER BY r.timestamp DESC
        LIMIT {{limit:Int32}} OFFSET {{offset:Int32}}
    """
    data_params = {**params, "limit": limit, "offset": offset}
    result = ch.query(data_query, parameters=data_params)

    count_query = f"""
        SELECT count()
        FROM detector_runs r
        LEFT JOIN detector_findings f
          ON r.finding_id = f.finding_id AND r.project_id = f.project_id
        WHERE {where_clause}
    """
    count_result = ch.query(count_query, parameters=params)
    total = count_result.result_rows[0][0] if count_result.result_rows else 0

    runs = []
    for row in result.result_rows:
        row_dict = dict(zip(result.column_names, row))
        if hasattr(row_dict.get("timestamp"), "isoformat"):
            row_dict["timestamp"] = row_dict["timestamp"].isoformat()
        runs.append(row_dict)

    return {
        "data": runs,
        "meta": {"page": page, "limit": limit, "total": total},
    }


@router.get(
    "/traces/{trace_id}/spans-jsonl",
    dependencies=[Depends(verify_internal_secret)],
)
async def get_spans_jsonl(trace_id: str, project_id: str):
    """Return all spans for a trace as newline-delimited JSON."""
    import json

    from fastapi.responses import PlainTextResponse

    ch = get_clickhouse_client()
    result = ch.query(
        """SELECT * FROM spans
           WHERE trace_id = {trace_id:String} AND project_id = {project_id:String}
           ORDER BY span_start_time""",
        parameters={"trace_id": trace_id, "project_id": project_id},
    )

    def _default(obj):
        if hasattr(obj, "isoformat"):
            return obj.isoformat()
        from decimal import Decimal

        if isinstance(obj, Decimal):
            return float(obj)
        raise TypeError(f"Object of type {type(obj).__name__} is not JSON serializable")

    lines = [
        json.dumps(dict(zip(result.column_names, row)), default=_default)
        for row in result.result_rows
    ]
    return PlainTextResponse("\n".join(lines))


@router.get(
    "/detector-findings",
    response_model=FindingListResponse,
    dependencies=[Depends(verify_internal_secret)],
)
async def list_detector_findings(
    project_id: str,
    detector_id: str,
    page: int = Query(0, ge=0, description="Page number (0-indexed)"),
    limit: int = Query(50, ge=1, le=200, description="Items per page"),
    start_after: datetime | None = Query(
        None, description="Filter findings at/after this timestamp (inclusive)"
    ),
    end_before: datetime | None = Query(
        None, description="Filter findings strictly before this timestamp"
    ),
    search_query: str | None = Query(
        None, description="Substring match against trace_id OR summary"
    ),
):
    """List findings for a detector (joined through runs), newest first.

    Param naming and pagination shape mirror the trace listing endpoints
    (`page`/`limit`/`start_after`/`end_before`/`search_query`) so the same
    `useListPageState` queryOptions can flow through unchanged.

    Returns {data: [...], meta: {page, limit, total}}.
    """
    ch = get_clickhouse_client()
    offset = page * limit

    conditions: list[str] = [
        "r.project_id = {project_id:String}",
        "r.detector_id = {detector_id:String}",
    ]
    params: dict = {
        "project_id": project_id,
        "detector_id": detector_id,
    }

    if start_after is not None:
        conditions.append("f.timestamp >= {start_after:DateTime64(3)}")
        params["start_after"] = to_utc_naive(start_after)

    if end_before is not None:
        conditions.append("f.timestamp < {end_before:DateTime64(3)}")
        params["end_before"] = to_utc_naive(end_before)

    if search_query:
        conditions.append(
            "(f.trace_id ILIKE {search_kw:String} OR f.summary ILIKE {search_kw:String})"
        )
        params["search_kw"] = f"%{escape_ilike(search_query)}%"

    where_clause = " AND ".join(conditions)

    data_query = f"""
        SELECT f.finding_id, f.project_id, f.trace_id, f.summary, f.payload, f.timestamp
        FROM detector_findings f
        INNER JOIN detector_runs r ON f.finding_id = r.finding_id
        WHERE {where_clause}
        ORDER BY f.timestamp DESC
        LIMIT {{limit:Int32}} OFFSET {{offset:Int32}}
    """
    data_params = {**params, "limit": limit, "offset": offset}
    result = ch.query(data_query, parameters=data_params)

    count_query = f"""
        SELECT count()
        FROM detector_findings f
        INNER JOIN detector_runs r ON f.finding_id = r.finding_id
        WHERE {where_clause}
    """
    count_result = ch.query(count_query, parameters=params)
    total = count_result.result_rows[0][0] if count_result.result_rows else 0

    findings = []
    for row in result.result_rows:
        row_dict = dict(zip(result.column_names, row))
        if hasattr(row_dict.get("timestamp"), "isoformat"):
            row_dict["timestamp"] = row_dict["timestamp"].isoformat()
        findings.append(row_dict)

    return {
        "data": findings,
        "meta": {"page": page, "limit": limit, "total": total},
    }


@router.get(
    "/traces/{trace_id}/findings",
    dependencies=[Depends(verify_internal_secret)],
)
async def get_trace_findings(trace_id: str, project_id: str):
    """List all detector findings for a specific trace."""
    ch = get_clickhouse_client()
    result = ch.query(
        """SELECT finding_id, project_id, trace_id, summary, payload, timestamp
           FROM detector_findings
           WHERE trace_id = {trace_id:String} AND project_id = {project_id:String}
           ORDER BY timestamp DESC""",
        parameters={"trace_id": trace_id, "project_id": project_id},
    )
    findings = []
    for row in result.result_rows:
        row_dict = dict(zip(result.column_names, row))
        if hasattr(row_dict.get("timestamp"), "isoformat"):
            row_dict["timestamp"] = row_dict["timestamp"].isoformat()
        findings.append(row_dict)
    return {"findings": findings}


@router.get(
    "/detector-counts",
    response_model=DetectorCountsResponse,
    dependencies=[Depends(verify_internal_secret)],
)
async def list_detector_counts(
    project_id: str,
    start_after: datetime = Query(
        ..., description="Lower bound on detector_runs.timestamp (inclusive)"
    ),
    end_before: datetime | None = Query(
        None, description="Upper bound on detector_runs.timestamp (exclusive)"
    ),
):
    """Aggregate finding and run counts per detector for a project, in one query.

    `detector_runs.finding_id` is set when a run produced a finding; counting
    `finding_id IS NOT NULL` avoids a JOIN with `detector_findings`.

    Detectors with zero runs in the window are absent from the result map; the
    frontend defaults absent entries to {findingCount: 0, runCount: 0}.
    """
    ch = get_clickhouse_client()

    conditions = [
        "project_id = {project_id:String}",
        "timestamp >= {start_after:DateTime64(3)}",
    ]
    params: dict = {
        "project_id": project_id,
        "start_after": to_utc_naive(start_after),
    }
    if end_before is not None:
        conditions.append("timestamp < {end_before:DateTime64(3)}")
        params["end_before"] = to_utc_naive(end_before)

    where_clause = " AND ".join(conditions)
    query = f"""
        SELECT
            detector_id,
            count()                          AS run_count,
            countIf(finding_id IS NOT NULL)  AS finding_count
        FROM detector_runs
        WHERE {where_clause}
        GROUP BY detector_id
    """

    result = ch.query(query, parameters=params)
    data: dict[str, dict[str, int]] = {}
    for row in result.result_rows:
        row_dict = dict(zip(result.column_names, row))
        data[row_dict["detector_id"]] = {
            "finding_count": int(row_dict["finding_count"]),
            "run_count": int(row_dict["run_count"]),
        }

    return {"data": data}
