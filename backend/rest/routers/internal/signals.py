"""Signal assignment endpoints for the detector worker.

The worker assigns detector hits to signals and keeps the assignment in
Postgres; ClickHouse holds a copy in ``signal_assignments``. A hit is waiting
when its detector run fired a finding and has no row there. Every read is
secret-gated and scoped by project and detector.
"""

import json
import logging
from datetime import UTC, datetime
from typing import Any

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel, Field, model_validator

from db.clickhouse.client import get_clickhouse_client
from rest.routers.internal.auth import verify_internal_secret

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/signals")

# One assignment round takes at most 200 hits; the cap leaves room without
# letting a caller pull a partition's whole history.
MAX_WAITING_HITS = 500
# Rows per write call; the worker flushes during a round, well below this.
MAX_ASSIGNMENT_ROWS = 500
# text-embedding-3-small is 1536-dimensional; anything much larger is a bug.
MAX_EMBEDDING_DIMS = 4096


def _ms_to_utc(ms: int) -> datetime:
    """Epoch milliseconds to an aware UTC datetime (clickhouse-connect reads a
    naive datetime as the client's local time)."""
    return datetime.fromtimestamp(ms / 1000, tz=UTC)


def _parse_data(raw: str) -> Any:
    """The detector's ``data`` as JSON; the raw text when it does not parse."""
    if not raw:
        return {}
    try:
        return json.loads(raw)
    except ValueError:
        return raw


@router.get("/waiting-hits", dependencies=[Depends(verify_internal_secret)])
async def list_waiting_hits(
    project_id: str,
    detector_id: str,
    since_ms: int = Query(..., ge=0),
    limit: int = Query(200, ge=1, le=MAX_WAITING_HITS),
):
    """List a partition's hits that have no assignment yet, oldest first.

    A hit is a detector run that fired a finding. Runs are collapsed with FINAL
    so a trace re-evaluated as clean no longer counts. The timestamp filter runs
    before the collapse, which is safe because a newer version of a run always
    has a later timestamp: the filter can drop old versions, never keep an old
    one while dropping its replacement. Assignments are only looked up from
    ``since`` on, since a hit is always assigned after it is detected.

    Args:
        project_id (str): Project of the partition.
        detector_id (str): Detector of the partition.
        since_ms (int): Only hits detected at or after this epoch-ms time.
        limit (int): Maximum hits returned.

    Returns:
        dict: ``{"data": [...]}``, each item with run_id, trace_id, finding_id,
            timestamp_ms, trace_start_ms (None when the trace row is gone),
            summary and data (the detector's output for this hit).
    """
    ch = get_clickhouse_client()
    params = {
        "project_id": project_id,
        "detector_id": detector_id,
        "since": _ms_to_utc(since_ms),
        "limit": limit,
    }
    runs = ch.query(
        """
        SELECT run_id, trace_id, finding_id, toUnixTimestamp64Milli(timestamp) AS timestamp_ms
        FROM (
            SELECT run_id, trace_id, finding_id, status, timestamp
            FROM detector_runs FINAL
            WHERE project_id = {project_id:String}
              AND detector_id = {detector_id:String}
              AND timestamp >= {since:DateTime64(3)}
        )
        WHERE finding_id IS NOT NULL
          AND status = 'completed'
          AND run_id NOT IN (
              SELECT run_id FROM signal_assignments
              WHERE project_id = {project_id:String}
                AND detector_id = {detector_id:String}
                AND assigned_at >= {since:DateTime64(3)}
          )
        ORDER BY timestamp_ms, run_id
        LIMIT {limit:UInt32}
        """,
        parameters=params,
    )
    rows = [dict(zip(runs.column_names, r)) for r in runs.result_rows]
    if not rows:
        return {"data": []}

    trace_ids = sorted({r["trace_id"] for r in rows})
    finding_ids = sorted({r["finding_id"] for r in rows})
    # The detector's own entry in each finding's payload (one entry per
    # detector that fired on the trace); argMax picks the latest re-write.
    entries = ch.query(
        """
        SELECT finding_id,
               arrayFirst(
                   x -> JSONExtractString(x, 'detectorId') = {detector_id:String},
                   JSONExtractArrayRaw(argMax(payload, timestamp))
               ) AS entry
        FROM detector_findings
        WHERE project_id = {project_id:String}
          AND trace_id IN {trace_ids:Array(String)}
          AND finding_id IN {finding_ids:Array(String)}
        GROUP BY finding_id
        """,
        parameters={
            "project_id": project_id,
            "detector_id": detector_id,
            "trace_ids": trace_ids,
            "finding_ids": finding_ids,
        },
    )
    entry_by_finding = {fid: entry for fid, entry in entries.result_rows}
    starts = ch.query(
        """
        SELECT trace_id, toUnixTimestamp64Milli(min(trace_start_time)) AS start_ms
        FROM traces
        WHERE project_id = {project_id:String}
          AND trace_id IN {trace_ids:Array(String)}
        GROUP BY trace_id
        """,
        parameters={"project_id": project_id, "trace_ids": trace_ids},
    )
    start_by_trace = {tid: start for tid, start in starts.result_rows}

    data = []
    for r in rows:
        entry = entry_by_finding.get(r["finding_id"]) or ""
        entry_obj = _parse_data(entry) if entry else {}
        if not isinstance(entry_obj, dict):
            entry_obj = {}
        summary = entry_obj.get("summary")
        data.append(
            {
                "run_id": r["run_id"],
                "trace_id": r["trace_id"],
                "finding_id": r["finding_id"],
                "timestamp_ms": int(r["timestamp_ms"]),
                "trace_start_ms": start_by_trace.get(r["trace_id"]),
                "summary": summary if isinstance(summary, str) else "",
                "data": entry_obj.get("data", {}),
            }
        )
    return {"data": data}


class SignalAssignmentRow(BaseModel):
    project_id: str = Field(min_length=1)
    detector_id: str = Field(min_length=1)
    run_id: str = Field(min_length=1)
    trace_id: str = Field(min_length=1)
    # Empty exactly when the worker gave up on the hit (see ``gave_up``).
    signal_id: str
    embedding: list[float] = Field(default_factory=list, max_length=MAX_EMBEDDING_DIMS)
    score: float | None = None
    criteria_version: int | None = Field(default=None, ge=0)
    assigned_at_ms: int = Field(ge=0)
    # The worker stopped retrying a hit whose model answers stayed unusable
    # (never for an outage): the row is written with an empty signal_id so the
    # hit no longer counts as waiting. scripts/replay_signal_hits.py undoes it.
    gave_up: bool = False

    @model_validator(mode="after")
    def _signal_id_matches_gave_up(self) -> "SignalAssignmentRow":
        if self.gave_up != (self.signal_id == ""):
            raise ValueError("signal_id must be empty exactly when gave_up is true")
        return self


class SignalAssignmentsPayload(BaseModel):
    rows: list[SignalAssignmentRow] = Field(max_length=MAX_ASSIGNMENT_ROWS)


@router.post("/assignments", dependencies=[Depends(verify_internal_secret)])
async def write_signal_assignments(body: SignalAssignmentsPayload):
    """Write the ClickHouse copy of hits the worker assigned in Postgres.

    Rewriting a run's row is harmless: the table keeps the row with the latest
    ``assigned_at`` per run.
    """
    ch = get_clickhouse_client()
    ch.insert_signal_assignments(
        [
            {
                **row.model_dump(exclude={"assigned_at_ms", "gave_up"}),
                "assigned_at": _ms_to_utc(row.assigned_at_ms),
            }
            for row in body.rows
        ]
    )
    return {"ok": True, "written": len(body.rows)}


class UnsettledRunsPayload(BaseModel):
    project_id: str = Field(min_length=1)
    # One assignment round touches at most 200 findings.
    finding_ids: list[str] = Field(min_length=1, max_length=MAX_WAITING_HITS)
    since_ms: int = Field(ge=0)


@router.post("/unsettled-runs", dependencies=[Depends(verify_internal_secret)])
async def list_unsettled_runs(body: UnsettledRunsPayload):
    """List the fired runs of these findings that have no assignment row yet.

    The worker starts a trace's RCA only once every hit of the trace is
    settled; these are the hits it may still wait for. A run is collapsed with
    FINAL as in ``waiting-hits``, so one re-evaluated as clean drops out; a hit
    the worker gave up on has a row, so it does not count as unsettled.

    Args:
        body (UnsettledRunsPayload): project_id, finding_ids, and since_ms (only
            runs detected at or after this epoch-ms time).

    Returns:
        dict: ``{"data": [...]}``, each item with finding_id, run_id,
            detector_id and timestamp_ms.
    """
    ch = get_clickhouse_client()
    params = {
        "project_id": body.project_id,
        "finding_ids": body.finding_ids,
        "since": _ms_to_utc(body.since_ms),
    }
    result = ch.query(
        """
        SELECT finding_id, run_id, detector_id, toUnixTimestamp64Milli(timestamp) AS timestamp_ms
        FROM (
            SELECT run_id, detector_id, finding_id, status, timestamp
            FROM detector_runs FINAL
            WHERE project_id = {project_id:String}
              AND timestamp >= {since:DateTime64(3)}
        )
        WHERE finding_id IN {finding_ids:Array(String)}
          AND status = 'completed'
          AND run_id NOT IN (
              SELECT run_id FROM signal_assignments
              WHERE project_id = {project_id:String}
                AND assigned_at >= {since:DateTime64(3)}
          )
        ORDER BY finding_id, run_id
        """,
        parameters=params,
    )
    return {
        "data": [
            {
                "finding_id": finding_id,
                "run_id": run_id,
                "detector_id": detector_id,
                "timestamp_ms": int(timestamp_ms),
            }
            for finding_id, run_id, detector_id, timestamp_ms in result.result_rows
        ]
    }
