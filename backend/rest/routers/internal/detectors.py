"""Detector endpoints: run/finding writes, run listings, and digest windows.

Every read is secret-gated and scoped by project id.
"""

import logging
from datetime import datetime
from typing import Any, Literal
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field

from db.clickhouse.client import ClickHouseClient, get_clickhouse_client
from rest.routers.internal.auth import verify_internal_secret
from rest.schemas.detectors import (
    DetectorWindowSummaryResponse,
    RunListResponse,
    TraceCountsResponse,
)
from rest.services.trace_reader import _evaluation_exclusion, customer_traffic_only
from rest.sql_utils import escape_ilike, to_utc_naive

logger = logging.getLogger(__name__)

router = APIRouter()

# Caps for the digest LLM-summary sample (see the window-summary endpoint).
# Enforced in ClickHouse so a finding storm never materializes unbounded rows.
DIGEST_SUMMARY_MAX_PER_DETECTOR = 10
DIGEST_SUMMARY_MAX_TOTAL = 40
DIGEST_SUMMARY_MAX_CHARS = 300


# NULL-preserving latest-finding pick for collapsing duplicate detector_runs
# rows by run_id. Tuple-wrapped because bare argMax skips NULL rows: a run
# whose newest row is a clean re-eval (NULL finding_id) must resolve to NULL,
# retracting its older finding. The ordering tuple breaks timestamp ties
# deterministically (non-null finding wins). Single source of truth so the
# counts query and the summaries probe can never disagree on which runs count
# as identified.
_LATEST_FINDING_PICK_SQL = (
    "tupleElement(argMax(tuple(finding_id), (timestamp, coalesce(finding_id, ''))), 1)"
)


def _detector_summary_expr(finding_id_col: str) -> str:
    """Build the SQL expression extracting a detector's summary from a finding.

    Single source of truth for what "the summary for this detector" means: a
    finding's ``payload`` is a JSON array of per-detector entries, and the
    summary is the ``summary`` field of the entry whose ``detectorId`` matches
    the run's ``r.detector_id`` ('' when the run has no finding). Every query
    that reads summaries must use this expression so the meaning cannot drift
    between endpoints.

    Args:
        finding_id_col (str): Qualified column holding the run's finding id
            (e.g. ``r.finding_id``, or ``r.latest_finding_id`` after a
            collapse); NULL means the run fired no finding.

    Returns:
        str: A ClickHouse expression over aliases ``r`` (runs side) and ``f``
            (findings side, providing ``f.payload``).
    """
    return (
        "if("
        f"  {finding_id_col} IS NOT NULL,"
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


class DetectorRunPayload(BaseModel):
    model_config = {"populate_by_name": True}

    run_id: str = Field(alias="runId")
    detector_id: str = Field(alias="detectorId")
    project_id: str = Field(alias="projectId")
    trace_id: str = Field(alias="traceId")
    finding_id: str | None = Field(default=None, alias="findingId")
    status: str
    # True when the worker emitted a self-trace for this run (set optimistically
    # at emit time); gates the runs-tab link to the run's own trace.
    self_traced: bool = Field(default=False, alias="selfTraced")
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
    cols = [
        "run_id",
        "detector_id",
        "project_id",
        "trace_id",
        "finding_id",
        "status",
        "self_traced",
    ]
    vals = [
        "{run_id:String}",
        "{detector_id:String}",
        "{project_id:String}",
        "{trace_id:String}",
        "{finding_id:Nullable(String)}",
        "{status:String}",
        "{self_traced:Bool}",
    ]
    params = {
        "run_id": body.run_id,
        "detector_id": body.detector_id,
        "project_id": body.project_id,
        "trace_id": body.trace_id,
        "finding_id": body.finding_id,
        "status": body.status,
        "self_traced": body.self_traced,
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

    # Reused in WHERE search and SELECT below.
    summary_expr = _detector_summary_expr("r.finding_id")

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
            r.self_traced AS self_traced,
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
    # version per span_id, then order for output. span_start_time is only
    # ms-precision, so sub-ms parallel siblings need span_end_time + span_id as
    # stable tie-breakers for deterministic export ordering.
    result = ch.query(
        """SELECT * FROM (
               SELECT * FROM spans
               WHERE trace_id = {trace_id:String} AND project_id = {project_id:String}
               ORDER BY ch_update_time DESC
               LIMIT 1 BY span_id
           )
           ORDER BY span_start_time ASC, span_end_time ASC, span_id ASC""",
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

    summary_expr = _detector_summary_expr("r.finding_id")

    query = f"""
        SELECT
            r.run_id      AS run_id,
            r.detector_id AS detector_id,
            r.project_id  AS project_id,
            r.trace_id    AS trace_id,
            r.finding_id  AS finding_id,
            r.status      AS status,
            r.timestamp   AS timestamp,
            r.self_traced AS self_traced,
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


def _fetch_sample_summaries(
    ch: ClickHouseClient, window_clause: str, params: dict[str, Any]
) -> dict[str, list[str]]:
    """Fetch recent per-detector finding summaries for a digest window.

    Best-effort by contract: digest jobs have no BullMQ retries, so a thrown
    flush loses the alert permanently — on any error (including exceeding the
    per-query execution cap) this logs and returns ``{}`` instead of raising,
    degrading the digest to counts-only.

    Sampling: newest-first within the window, at most
    ``DIGEST_SUMMARY_MAX_PER_DETECTOR`` per detector and
    ``DIGEST_SUMMARY_MAX_TOTAL`` overall (rank-major, so one chatty detector
    cannot starve the others), each truncated to ``DIGEST_SUMMARY_MAX_CHARS``
    chars in SQL.

    Args:
        ch (ClickHouseClient): ClickHouse client to query with.
        window_clause (str): SQL predicate over the collapsed ``ts`` bounding
            the digest window (parameter placeholders, not inlined values).
        params (dict[str, Any]): Bound query parameters; must include
            ``project_id`` and every placeholder referenced by
            ``window_clause``.

    Returns:
        dict[str, list[str]]: detector_id -> its sampled summaries, newest
            first. Empty on failure or when nothing matched.
    """
    try:
        summary_expr = _detector_summary_expr("r.latest_finding_id")
        # Probe side bounded BEFORE the join (window bound, non-null
        # finding, per-detector cap), so the join probes at most
        # DIGEST_SUMMARY_MAX_PER_DETECTOR x n_detectors rows. RCA-disabled
        # detectors still consume budget here (the digest drops them
        # later); accepted for v1. Written once and reused in the join's
        # semi-filter below, at the cost of ClickHouse evaluating it twice
        # (the runs collapse is far cheaper than a whole-history payload
        # read).
        sampled_probe = f"""
                    SELECT detector_id, latest_finding_id, ts
                    FROM (
                        SELECT
                            detector_id,
                            run_id,
                            -- NULL-preserving shared pick; determinism
                            -- matters doubly here — this probe is evaluated
                            -- twice (FROM + IN) and both must select the
                            -- same finding id on a timestamp tie.
                            {_LATEST_FINDING_PICK_SQL} AS latest_finding_id,
                            max(timestamp)                AS ts
                        FROM detector_runs
                        WHERE project_id = {{project_id:String}}
                        GROUP BY detector_id, run_id
                    )
                    WHERE {window_clause} AND latest_finding_id IS NOT NULL
                    -- latest_finding_id tiebreaker: the probe is evaluated
                    -- twice (FROM + IN); ties on ts must pick identical rows.
                    ORDER BY detector_id, ts DESC, latest_finding_id
                    LIMIT {DIGEST_SUMMARY_MAX_PER_DETECTOR} BY detector_id
        """
        summaries_query = f"""
            SELECT detector_id, summary
            FROM (
                SELECT
                    r.detector_id AS detector_id,
                    -- substringUTF8, not substring: a byte-offset cut can
                    -- split a multibyte char, and clickhouse-connect
                    -- replaces an undecodable string with its hex dump.
                    substringUTF8({summary_expr}, 1, {DIGEST_SUMMARY_MAX_CHARS}) AS summary,
                    r.ts AS ts,
                    -- Rank-major allocation: every detector keeps its
                    -- newest sentence before any detector gets its
                    -- 2nd..10th, so one chatty detector cannot starve the
                    -- others out of the overall budget.
                    row_number() OVER (
                        PARTITION BY r.detector_id ORDER BY r.ts DESC
                    ) AS rank
                FROM (
                    {sampled_probe}
                ) AS r
                INNER JOIN (
                    -- Semi-join to the sampled finding ids so the FINAL
                    -- read touches only those findings' payloads, not the
                    -- project's whole finding history.
                    SELECT finding_id, payload FROM detector_findings FINAL
                    WHERE project_id = {{project_id:String}}
                      AND finding_id IN (
                        SELECT latest_finding_id FROM ({sampled_probe})
                      )
                ) AS f ON r.latest_finding_id = f.finding_id
                -- Empty summaries (payload without a matching entry) are
                -- filtered before ranking so they never eat sample slots.
                WHERE summary != ''
            )
            ORDER BY rank ASC, ts DESC
            LIMIT {DIGEST_SUMMARY_MAX_TOTAL}
        """
        # Bound the digest read: on a huge project a stalled summaries
        # query must degrade to counts-only (via the except path, per the
        # best-effort contract) instead of holding the worker's HTTP call.
        result = ch.query(
            summaries_query,
            parameters=params,
            settings={"max_execution_time": 10},
        )
        summaries: dict[str, list[str]] = {}
        for detector_id, summary in result.result_rows:
            summaries.setdefault(detector_id, []).append(summary)
        return summaries
    except Exception:
        logger.exception(
            "detector-window-summary: summaries read failed; "
            "returning counts without sample_summaries"
        )
        return {}


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
    include_summaries: bool = Query(
        False,
        description=(
            "When true, also return recent per-detector finding summaries "
            "(capped in SQL) for the digest LLM summary"
        ),
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

    When ``include_summaries`` is set, a second bounded query returns each
    detector's most recent per-detector judge summaries within the window:
    newest-first, at most ``DIGEST_SUMMARY_MAX_PER_DETECTOR`` per detector and
    ``DIGEST_SUMMARY_MAX_TOTAL`` overall, each truncated to
    ``DIGEST_SUMMARY_MAX_CHARS`` chars in SQL. The per-detector sentence is
    JSON-extracted from the finding payload with the same expression as the
    runs endpoints (one source of truth). UI consumers never set the flag, so
    their read cost is unchanged. The summaries read is best-effort: on any
    error, including exceeding its per-query execution cap, it is logged and
    the response is returned without ``sample_summaries`` (counts intact) — it
    can never fail the endpoint.
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
                -- NULL-preserving shared pick: the count must retract a
                -- clean re-eval'd run exactly when the sample does.
                {_LATEST_FINDING_PICK_SQL} AS latest_finding_id,
                argMax(trace_id, timestamp) AS latest_trace_id,
                max(timestamp)              AS ts
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

    if include_summaries and any(v["finding_count"] > 0 for v in data.values()):
        for detector_id, summaries in _fetch_sample_summaries(ch, window_clause, params).items():
            if detector_id in data:
                data[detector_id]["sample_summaries"] = summaries

    return {"data": data}


def _format_tz_offset(total_seconds: int) -> str:
    """ "+HH:MM" / "-HH:MM" for a UTC offset in seconds.

    Mirrors ``formatOffset``/``tzOffsetMinutes`` in core's ``signals/reads.ts`` exactly
    (same sign convention, same zero-padded "+HH:MM"): the chart population computed
    here is joined to the signal's own hit series by bucket key in route-handlers.ts,
    so the two must format an offset identically or the join silently drops a bucket.
    """
    sign = "+" if total_seconds >= 0 else "-"
    minutes = abs(total_seconds) // 60
    hh, mm = divmod(minutes, 60)
    return f"{sign}{hh:02d}:{mm:02d}"


@router.get(
    "/trace-counts",
    response_model=TraceCountsResponse,
    dependencies=[Depends(verify_internal_secret)],
)
def list_trace_counts(
    project_id: str,
    start_after: datetime = Query(..., description="Window start (inclusive)"),
    end_before: datetime = Query(..., description="Window end (exclusive)"),
    detector_id: str | None = Query(
        None, description="Count the traces this detector checked; all traces when omitted"
    ),
    granularity: Literal["hour", "day"] = Query("day", description="Bucket width"),
    tz: str = Query(
        "UTC",
        description="IANA zone name local buckets are computed in, e.g. 'America/New_York'",
    ),
):
    """Traces per LOCAL hour or day in ``tz``: the ones a detector checked, or all of them.

    Both populations count distinct traces by trace start time. With
    ``detector_id``, only traces this detector has evaluated are included; retries
    never count twice or move a trace into the detection-time bucket.

    Args:
        project_id (str): Project to count in.
        start_after (datetime): Window start (inclusive).
        end_before (datetime): Window end (exclusive).
        detector_id (str | None): Detector whose checked traces to count.
        granularity (str): ``hour`` or ``day``.
        tz (str): IANA zone name the buckets are computed in. Validated against the
            system's tz database before it reaches SQL, so an unknown name is a 422,
            not a ClickHouse error.

    Returns:
        TraceCountsResponse: One row per bucket with at least one trace, ordered
        ascending; a bucket is ``YYYY-MM-DD`` (day) or ``YYYY-MM-DDTHH:00±HH:MM``
        (hour, suffixed with ``tz``'s UTC offset at that hour) in ``tz``. The offset
        is what tells apart the two real local hours of a DST fall-back night, which
        otherwise both print the same ``HH:00`` — see ``_format_tz_offset``. Empty
        buckets are omitted.
    """
    try:
        ZoneInfo(tz)
    except (ZoneInfoNotFoundError, ValueError) as e:
        raise HTTPException(status_code=422, detail=f"Unknown timezone: {tz!r}") from e

    ch = get_clickhouse_client()
    params: dict = {
        "project_id": project_id,
        "start_after": to_utc_naive(start_after),
        "end_before": to_utc_naive(end_before),
        "tz": tz,
    }
    checked = ""
    if detector_id is not None:
        params["detector_id"] = detector_id
        checked = """
              AND trace_id IN (
                  SELECT trace_id FROM detector_runs
                  WHERE project_id = {project_id:String}
                    AND detector_id = {detector_id:String}
                    AND trace_id IN (
                        SELECT trace_id FROM traces
                        WHERE project_id = {project_id:String}
                          AND trace_start_time >= {start_after:DateTime64(3)}
                          AND trace_start_time < {end_before:DateTime64(3)}
                    )
              )
        """
    # Same customer-traffic and evaluation exclusions the Traces list applies, so this
    # chart's "all traces" population matches what the user can actually see there
    # instead of also counting detector/assistant self-traces and offline-eval runs.
    source = f"""
        SELECT t.trace_id AS id, argMax(t.trace_start_time, t.ch_update_time) AS ts
        FROM traces t
        WHERE t.project_id = {{project_id:String}}
          AND t.trace_id IN (
              SELECT trace_id FROM traces
              WHERE project_id = {{project_id:String}}
                AND trace_start_time >= {{start_after:DateTime64(3)}}
                AND trace_start_time < {{end_before:DateTime64(3)}}
          )
          AND {customer_traffic_only("t")}
          AND {_evaluation_exclusion(params)}
          {checked}
        GROUP BY t.trace_id
    """
    counted = "uniqExact(id)"
    window_clause = "ts >= {start_after:DateTime64(3)} AND ts < {end_before:DateTime64(3)}"

    if granularity == "day":
        # Unaffected by DST: a local day never repeats, so no offset is needed and
        # day buckets stay exactly the plain "YYYY-MM-DD" they always were.
        query = f"""
            SELECT toString(toDate(ts, {{tz:String}})) AS bucket, {counted} AS count
            FROM ({source})
            WHERE {window_clause}
            GROUP BY bucket
            ORDER BY bucket
        """
        result = ch.query(query, parameters=params)
        data = [{"bucket": row[0], "count": int(row[1])} for row in result.result_rows]
        return {"data": data}

    # Hour buckets: group by the bucket's actual instant (toStartOfHour, a real UTC
    # moment), not by its formatted label. On a DST fall-back night the two real local
    # "01:00" hours ARE two different instants here, so they stay two groups; grouping
    # by the formatted text instead (the earlier bug) would merge them before the
    # offset ever entered the picture. timeZoneOffset reads tz's offset at that same
    # instant, so each group gets the offset of the hour it actually occurred in.
    query = f"""
        SELECT
            formatDateTime(bucket_start, '%Y-%m-%dT%H:00', {{tz:String}}) AS label,
            toInt32(timeZoneOffset(bucket_start)) AS offset_seconds,
            {counted} AS count
        FROM (
            SELECT toStartOfHour(ts, {{tz:String}}) AS bucket_start, id
            FROM ({source})
            WHERE {window_clause}
        )
        GROUP BY bucket_start
        ORDER BY bucket_start
    """
    result = ch.query(query, parameters=params)
    data = [
        {"bucket": f"{label}{_format_tz_offset(int(offset_seconds))}", "count": int(count)}
        for label, offset_seconds, count in result.result_rows
    ]
    return {"data": data}
