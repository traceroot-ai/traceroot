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
    DetectorWindowSummaryResponse,
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
    detector_runs: int = 0


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

    # ReplacingMergeTree dedup via uniqExact — same trace/span id can have
    # multiple pre-merge rows in ClickHouse.
    result = ch.query(
        """
        SELECT (
            (SELECT uniqExact(trace_id) FROM traces
             WHERE project_id IN {project_ids:Array(String)}
               AND ch_create_time >= {start:String}
               AND ch_create_time < {end:String})
          + (SELECT uniqExact(span_id) FROM spans
             WHERE project_id IN {project_ids:Array(String)}
               AND ch_create_time >= {start:String}
               AND ch_create_time < {end:String})
        ) as total
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
        return UsageDetailsResponse(traces=0, spans=0, detector_runs=0)

    ch = get_clickhouse_client()

    # Format datetime without timezone for ClickHouse
    start_str = start.strftime("%Y-%m-%d %H:%M:%S")
    end_str = end.strftime("%Y-%m-%d %H:%M:%S")

    # Query traces count — uniqExact dedups across pre-merge ReplacingMergeTree
    # rows (a single trace can have multiple rows until background merge runs,
    # e.g. on status update). uniqExact is faster than count(DISTINCT trace_id)
    # in ClickHouse and produces identical results.
    traces_result = ch.query(
        """
        SELECT uniqExact(trace_id) as total
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

    # Query spans count — same uniqExact pattern for ReplacingMergeTree dedup
    spans_result = ch.query(
        """
        SELECT uniqExact(span_id) as total
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

    # Detector runs: count every scan attempt recorded by the detector worker
    # (BYOK + system source both count toward Free-plan hard cap).
    # uniqExact on run_id dedups pre-merge duplicates in the ReplacingMergeTree —
    # same pattern as the traces / spans queries above.
    detector_runs_result = ch.query(
        """
        SELECT uniqExact(run_id) as total
        FROM detector_runs
        WHERE project_id IN {project_ids:Array(String)}
          AND timestamp >= {start:String}
          AND timestamp < {end:String}
        """,
        parameters={
            "project_ids": project_id_list,
            "start": start_str,
            "end": end_str,
        },
    )
    detector_runs = (
        int(detector_runs_result.result_rows[0][0]) if detector_runs_result.result_rows else 0
    )

    return UsageDetailsResponse(traces=traces, spans=spans, detector_runs=detector_runs)


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
    # Optional worker epoch-ms time for the row; see _maybe_stamp_timestamp.
    timestamp_ms: int | None = Field(default=None, alias="timestampMs")


class DetectorFindingPayload(BaseModel):
    model_config = {"populate_by_name": True}

    finding_id: str = Field(alias="findingId")
    project_id: str = Field(alias="projectId")
    trace_id: str = Field(alias="traceId")
    summary: str
    payload: str
    # See DetectorRunPayload.timestamp_ms.
    timestamp_ms: int | None = Field(default=None, alias="timestampMs")


def _maybe_stamp_timestamp(
    cols: list[str], vals: list[str], params: dict, timestamp_ms: int | None
) -> None:
    """Append the optional worker timestamp to an INSERT's column/value/param lists.

    When ``timestamp_ms`` is provided the worker's finding-capture time is stored
    verbatim, so the digest window count (which filters on ``timestamp``) uses the
    same clock the flush is keyed off; when ``None`` the column is omitted and
    ClickHouse applies its ``now64(3)`` default.

    Args:
        cols (list[str]): INSERT column names, appended in place.
        vals (list[str]): INSERT value placeholders, appended in place.
        params (dict): Bound query parameters, updated in place.
        timestamp_ms (int | None): Worker epoch-ms timestamp, or None to skip.

    Returns:
        None
    """
    if timestamp_ms is not None:
        cols.append("timestamp")
        vals.append("fromUnixTimestamp64Milli({timestamp_ms:Int64})")
        params["timestamp_ms"] = timestamp_ms


@router.post("/detector-runs", dependencies=[Depends(verify_internal_secret)])
async def write_detector_run(body: DetectorRunPayload):
    """Record a detector run result in ClickHouse.

    A worker-supplied ``timestamp_ms`` is written into ``timestamp`` verbatim so
    the digest's window count uses the same clock the flush is keyed off;
    otherwise ClickHouse defaults the column to ``now64(3)`` at INSERT.
    """
    ch = get_clickhouse_client()
    cols = ["run_id", "detector_id", "project_id", "trace_id", "finding_id", "status"]
    vals = [
        "{run_id:String}",
        "{detector_id:String}",
        "{project_id:String}",
        "{trace_id:String}",
        "{finding_id:Nullable(String)}",
        "{status:String}",
    ]
    params = {
        "run_id": body.run_id,
        "detector_id": body.detector_id,
        "project_id": body.project_id,
        "trace_id": body.trace_id,
        "finding_id": body.finding_id,
        "status": body.status,
    }
    _maybe_stamp_timestamp(cols, vals, params, body.timestamp_ms)
    ch.query(
        f"INSERT INTO detector_runs ({', '.join(cols)}) VALUES ({', '.join(vals)})",
        parameters=params,
    )
    return {"ok": True}


@router.post("/detector-findings", dependencies=[Depends(verify_internal_secret)])
async def write_detector_finding(body: DetectorFindingPayload):
    """Record a detector finding in ClickHouse.

    ``timestamp_ms`` behaves as in :func:`write_detector_run`.
    """
    ch = get_clickhouse_client()
    cols = ["finding_id", "project_id", "trace_id", "summary", "payload"]
    vals = [
        "{finding_id:String}",
        "{project_id:String}",
        "{trace_id:String}",
        "{summary:String}",
        "{payload:String}",
    ]
    params = {
        "finding_id": body.finding_id,
        "project_id": body.project_id,
        "trace_id": body.trace_id,
        "summary": body.summary,
        "payload": body.payload,
    }
    _maybe_stamp_timestamp(cols, vals, params, body.timestamp_ms)
    ch.query(
        f"INSERT INTO detector_findings ({', '.join(cols)}) VALUES ({', '.join(vals)})",
        parameters=params,
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
    identified: bool = Query(
        False,
        description="When true, return only triggered runs (finding_id IS NOT NULL)",
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

    Args:
        identified (bool): When true, restrict to runs that triggered a finding
            (``finding_id IS NOT NULL``). Defaults to false (all runs). The
            Findings tab uses this to render itself as a filtered Runs view.

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

    if identified:
        conditions.append("r.finding_id IS NOT NULL")

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

    # Read both tables with FINAL so pre-merge ReplacingMergeTree duplicates (a
    # retried run/finding re-written under the same deterministic id) don't fan
    # out the LEFT JOIN into duplicate rows or inflate the paginated count.
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
        FROM (SELECT * FROM detector_runs FINAL) AS r
        LEFT JOIN (SELECT * FROM detector_findings FINAL) AS f
          ON r.finding_id = f.finding_id AND r.project_id = f.project_id
        WHERE {where_clause}
        ORDER BY r.timestamp DESC
        LIMIT {{limit:Int32}} OFFSET {{offset:Int32}}
    """
    data_params = {**params, "limit": limit, "offset": offset}
    result = ch.query(data_query, parameters=data_params)

    count_query = f"""
        SELECT count()
        FROM (SELECT * FROM detector_runs FINAL) AS r
        LEFT JOIN (SELECT * FROM detector_findings FINAL) AS f
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
    # Dedup ReplacingMergeTree rows without FINAL (FINAL scans all parts and
    # defeats the trace_id-first sort key / no-IO projection): keep the latest
    # version per span_id, then order for output.
    result = ch.query(
        """SELECT * FROM (
               SELECT * FROM spans
               WHERE trace_id = {trace_id:String} AND project_id = {project_id:String}
               ORDER BY ch_update_time DESC
               LIMIT 1 BY span_id
           )
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
    "/traces/{trace_id}/time-since-last-span",
    dependencies=[Depends(verify_internal_secret)],
)
async def get_time_since_last_span(trace_id: str, project_id: str):
    """Report how long a trace has been quiet — milliseconds since its last span.

    The detector worker waits until this reaches EVALUATOR_DELAY before
    evaluating (a quiescence debounce). The age is computed inside ClickHouse
    (now64() vs max(ch_create_time)) to avoid clock skew between services. An
    empty trace reports age 0, i.e. "not quiet yet".

    Args:
        trace_id (str): Trace whose quiet duration to report.
        project_id (str): Project that owns the trace; scopes the query.

    Returns:
        dict: ``{"time_since_last_span_ms": int}`` — milliseconds since the most
            recent span of the trace was ingested, clamped to >= 0; 0 when the
            trace has no spans yet.
    """
    ch = get_clickhouse_client()

    agg = ch.query(
        """SELECT
               greatest(0, date_diff('millisecond', max(ch_create_time), now64(3)))
                   AS time_since_last_span_ms
           FROM spans
           WHERE trace_id = {trace_id:String} AND project_id = {project_id:String}""",
        parameters={"trace_id": trace_id, "project_id": project_id},
    )
    row = agg.result_rows[0] if agg.result_rows else None
    age = int(row[0]) if row and row[0] is not None else 0
    return {"time_since_last_span_ms": age}


@router.get(
    "/traces/{trace_id}/findings",
    dependencies=[Depends(verify_internal_secret)],
)
async def get_trace_findings(trace_id: str, project_id: str):
    """List all detector findings recorded for a single trace.

    Queries the ``detector_findings`` table with ``FINAL`` so pre-merge
    ReplacingMergeTree duplicates (a finding can be re-written under the same
    deterministic ``finding_id`` on a retry) collapse to one row per finding.
    Timestamps are normalised to ISO-8601 strings for JSON serialisation.

    Args:
        trace_id (str): Trace whose findings to return.
        project_id (str): Project that owns the trace; scopes the query.

    Returns:
        dict: ``{"findings": list[dict]}`` ordered newest-first, each finding a
            dict of ``finding_id``, ``project_id``, ``trace_id``, ``summary``,
            ``payload`` and ISO-8601 ``timestamp``. The list is empty when the
            trace has no findings.
    """
    ch = get_clickhouse_client()
    result = ch.query(
        """SELECT finding_id, project_id, trace_id, summary, payload, timestamp
           FROM detector_findings FINAL
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
    "/traces/{trace_id}/detector-runs",
    dependencies=[Depends(verify_internal_secret)],
)
async def list_trace_detector_runs(trace_id: str, project_id: str):
    """List every detector run recorded against a single trace.

    Both ``detector_runs`` and ``detector_findings`` are ReplacingMergeTree
    tables that can hold pre-merge duplicates (a run/finding may be re-written
    under the same deterministic id on a retry), so both are read with
    ``FINAL`` to collapse to one row apiece. Triggered runs LEFT JOIN their
    finding to surface this detector's per-detector summary string; clean runs
    have a null ``finding_id`` and an empty summary.

    Args:
        trace_id (str): Trace whose detector runs to return.
        project_id (str): Project that owns the trace; scopes the query.

    Returns:
        dict: ``{"runs": list[dict]}`` ordered by ``detector_id``, each run a
            dict of ``run_id``, ``detector_id``, ``project_id``, ``trace_id``,
            ``finding_id`` (``None`` for clean runs), ``status``, ISO-8601
            ``timestamp`` and ``summary``. Empty when the trace has no runs.
    """
    ch = get_clickhouse_client()

    # Per-detector summary expression; identical to list_detector_runs so the
    # meaning of "the summary for this detector" stays in one place.
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

    query = f"""
        SELECT
            r.run_id      AS run_id,
            r.detector_id AS detector_id,
            r.project_id  AS project_id,
            r.trace_id    AS trace_id,
            r.finding_id  AS finding_id,
            r.status      AS status,
            r.timestamp   AS timestamp,
            {summary_expr} AS summary
        FROM (SELECT * FROM detector_runs FINAL) AS r
        LEFT JOIN (SELECT * FROM detector_findings FINAL) AS f
          ON r.finding_id = f.finding_id AND r.project_id = f.project_id
        WHERE r.trace_id = {{trace_id:String}}
          AND r.project_id = {{project_id:String}}
        ORDER BY r.detector_id
    """
    result = ch.query(query, parameters={"trace_id": trace_id, "project_id": project_id})

    runs = []
    for row in result.result_rows:
        row_dict = dict(zip(result.column_names, row))
        if hasattr(row_dict.get("timestamp"), "isoformat"):
            row_dict["timestamp"] = row_dict["timestamp"].isoformat()
        runs.append(row_dict)
    return {"runs": runs}


@router.get(
    "/detector-window-summary",
    response_model=DetectorWindowSummaryResponse,
    dependencies=[Depends(verify_internal_secret)],
)
async def list_detector_window_summary(
    project_id: str,
    start_after: datetime = Query(
        ..., description="Lower bound on detector_runs.timestamp (inclusive)"
    ),
    end_before: datetime | None = Query(
        None, description="Upper bound on detector_runs.timestamp (exclusive)"
    ),
):
    """Aggregate run/finding counts and the latest triggered trace per detector.

    Dedup without FINAL: ``detector_runs`` is a ``ReplacingMergeTree`` whose
    duplicates are idempotent retries sharing a deterministic ``run_id`` (the
    larger ``timestamp`` wins). The inner query collapses each ``run_id`` to its
    latest version via ``argMax`` / ``max(timestamp)`` over the project's whole
    history; the outer query then windows on that collapsed ``ts``. That yields
    exactly the rows ``FINAL`` would have surfaced ("latest row wins, then
    filter") — including for a retry that re-stamps across a window boundary —
    but as a streamed aggregate rather than a merge-on-read (the construct that
    OOM-killed rest on the big ``spans`` table; see the 2026-06-25 incident).

    A run carries its ``finding_id`` and the ``trace_id`` it fired on, so
    ``finding_count`` and ``sample_trace_ids`` come straight off the runs — no
    ``detector_findings`` JOIN, and no second per-detector read (the digest used
    to fetch the latest trace via a now-removed ``GET /detector-findings``;
    folding it in here removes that N+1). ``sample_trace_ids`` holds the most
    recent *triggered* run's trace (one today, shaped as a list so we can
    surface more later), or an empty list for a detector that ran but never
    fired.

    Detectors with no runs in the window are omitted; the frontend defaults
    absent entries to {findingCount: 0, runCount: 0}.
    """
    ch = get_clickhouse_client()

    # Window on the collapsed timestamp (outer), not the raw rows (inner): the
    # dedup must happen first so a run is placed by its latest version, matching
    # FINAL across retries that re-stamp near a window boundary.
    params: dict = {
        "project_id": project_id,
        "start_after": to_utc_naive(start_after),
    }
    window_conditions = ["ts >= {start_after:DateTime64(3)}"]
    if end_before is not None:
        window_conditions.append("ts < {end_before:DateTime64(3)}")
        params["end_before"] = to_utc_naive(end_before)
    window_clause = " AND ".join(window_conditions)

    query = f"""
        SELECT
            detector_id,
            count()                                                      AS run_count,
            countIf(latest_finding_id IS NOT NULL)                       AS finding_count,
            argMaxIf(latest_trace_id, ts, latest_finding_id IS NOT NULL) AS latest_trace_id
        FROM (
            SELECT
                detector_id,
                run_id,
                argMax(finding_id, timestamp) AS latest_finding_id,
                argMax(trace_id,   timestamp) AS latest_trace_id,
                max(timestamp)                AS ts
            FROM detector_runs
            WHERE project_id = {{project_id:String}}
            GROUP BY detector_id, run_id
        )
        WHERE {window_clause}
        GROUP BY detector_id
    """

    result = ch.query(query, parameters=params)
    data: dict[str, dict] = {}
    for row in result.result_rows:
        row_dict = dict(zip(result.column_names, row))
        # One representative trace today, shaped as a list so surfacing more
        # later (groupArray in the query) needs no contract change. "" (a
        # detector that ran but never fired) collapses to an empty list.
        latest_trace_id = row_dict["latest_trace_id"]
        data[row_dict["detector_id"]] = {
            "finding_count": int(row_dict["finding_count"]),
            "run_count": int(row_dict["run_count"]),
            "sample_trace_ids": [latest_trace_id] if latest_trace_id else [],
        }

    return {"data": data}
