"""Internal API endpoints for worker/service communication.

These endpoints are protected by X-Internal-Secret header and not exposed publicly.
"""

import hmac
from datetime import datetime
from typing import Annotated

from fastapi import APIRouter, Depends, Header, HTTPException, Query
from pydantic import BaseModel, Field

from db.clickhouse.client import get_clickhouse_client
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


@router.get("/detector-runs", dependencies=[Depends(verify_internal_secret)])
async def list_detector_runs(
    project_id: str,
    detector_id: str,
    limit: int = 50,
    offset: int = 0,
):
    """List runs for a detector, newest first.

    For triggered runs, JOIN with detector_findings to surface this detector's
    per-detector summary string (the finding's `payload` is the combined
    array of all triggered detectors for the trace; we filter to the entry
    matching this run's detector_id).
    """
    ch = get_clickhouse_client()
    result = ch.query(
        """SELECT
             r.run_id      AS run_id,
             r.detector_id AS detector_id,
             r.project_id  AS project_id,
             r.trace_id    AS trace_id,
             r.finding_id  AS finding_id,
             r.status      AS status,
             r.timestamp   AS timestamp,
             if(
               r.finding_id IS NOT NULL,
               JSONExtractString(
                 arrayFirst(
                   x -> JSONExtractString(x, 'detectorId') = r.detector_id,
                   JSONExtractArrayRaw(f.payload)
                 ),
                 'summary'
               ),
               ''
             ) AS summary
           FROM detector_runs r
           LEFT JOIN detector_findings f
             ON r.finding_id = f.finding_id AND r.project_id = f.project_id
           WHERE r.project_id = {project_id:String} AND r.detector_id = {detector_id:String}
           ORDER BY r.timestamp DESC
           LIMIT {limit:Int32} OFFSET {offset:Int32}""",
        parameters={
            "project_id": project_id,
            "detector_id": detector_id,
            "limit": limit,
            "offset": offset,
        },
    )
    runs = []
    for row in result.result_rows:
        row_dict = dict(zip(result.column_names, row))
        if hasattr(row_dict.get("timestamp"), "isoformat"):
            row_dict["timestamp"] = row_dict["timestamp"].isoformat()
        runs.append(row_dict)
    return {"runs": runs}


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


@router.get("/detector-findings", dependencies=[Depends(verify_internal_secret)])
async def list_detector_findings(
    project_id: str,
    detector_id: str,
    limit: int = 50,
    offset: int = 0,
    since: str | None = None,
):
    """List findings for a detector (joined through runs), newest first."""
    ch = get_clickhouse_client()
    since_clause = "AND f.timestamp >= {since:String}" if since else ""
    params: dict = {
        "project_id": project_id,
        "detector_id": detector_id,
        "limit": limit,
        "offset": offset,
    }
    if since:
        params["since"] = since
    result = ch.query(
        f"""SELECT f.finding_id, f.project_id, f.trace_id, f.summary, f.payload, f.timestamp
            FROM detector_findings f
            INNER JOIN detector_runs r ON f.finding_id = r.finding_id
            WHERE r.project_id = {{project_id:String}}
              AND r.detector_id = {{detector_id:String}}
            {since_clause}
            ORDER BY f.timestamp DESC
            LIMIT {{limit:Int32}} OFFSET {{offset:Int32}}""",
        parameters=params,
    )
    findings = []
    for row in result.result_rows:
        row_dict = dict(zip(result.column_names, row))
        if hasattr(row_dict.get("timestamp"), "isoformat"):
            row_dict["timestamp"] = row_dict["timestamp"].isoformat()
        findings.append(row_dict)
    return {"findings": findings}


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
