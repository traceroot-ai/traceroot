"""Task-group endpoints for the worker that summarizes and places traces.

The worker never talks to ClickHouse itself; these handlers run its queries.
A project's traces are sampled, each sampled trace gets a one-sentence
summary of its task plus the embedding of that summary (``trace_task_digests``),
a periodic fit writes the groups (``task_groups``), and each digested trace is
placed in the nearest group it falls inside (``trace_group_members``).
Every read is secret-gated and scoped by project.

The handlers are plain functions so FastAPI runs them in its thread pool and
the blocking ClickHouse calls do not hold up the event loop.
"""

from datetime import UTC, datetime

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel, Field

from db.clickhouse.client import get_clickhouse_client
from rest.routers.internal.auth import verify_internal_secret

router = APIRouter(prefix="/task-groups")

# The one question asked of each trace today (see the ``lens`` columns).
DEFAULT_LENS = "task"
MAX_CANDIDATES = 5_000
MAX_WRITE_ROWS = 500
MAX_EMBEDDING_DIMS = 4096

# The sampling order: the first eight bytes of sha256("<project>:<trace>") read as a
# big-endian unsigned integer. The worker computes the same number (sampler.ts), so
# "which traces come first" is one rule on both sides, and a trace's place in it never
# depends on when it is looked at.
_SAMPLE_KEY_SQL = (
    "reinterpretAsUInt64(reverse(substring(SHA256(concat(project_id, ':', trace_id)), 1, 8)))"
)


def _ms_to_utc(ms: int) -> datetime:
    """Epoch milliseconds to an aware UTC datetime (clickhouse-connect reads a
    naive datetime as the client's local time)."""
    return datetime.fromtimestamp(ms / 1000, tz=UTC)


@router.get("/candidates", dependencies=[Depends(verify_internal_secret)])
def list_candidates(
    project_id: str,
    since_ms: int = Query(..., ge=0),
    until_ms: int = Query(..., ge=0),
    idle_before_ms: int = Query(..., ge=0),
    limit: int = Query(500, ge=1, le=MAX_CANDIDATES),
    lens: str = DEFAULT_LENS,
):
    """List traces that could be summarized, in sampling order, and how many of the
    window already have a summary.

    A candidate started in ``[since_ms, until_ms)``, has had no write since
    ``idle_before_ms`` (so it is finished), and has no summary yet for ``lens``.
    The order is the sampling key, ascending, so the first N rows are the sample.

    Returns:
        dict: ``{"data": [{trace_id, trace_time_ms, key}], "digested": n}``. ``key`` is a
            decimal string: it can exceed what a JSON number holds exactly.
    """
    ch = get_clickhouse_client()
    params = {
        "project_id": project_id,
        "since": _ms_to_utc(since_ms),
        "until": _ms_to_utc(until_ms),
        "idle_before": _ms_to_utc(idle_before_ms),
        "lens": lens,
        "limit": limit,
    }
    rows = ch.query(
        f"""
        SELECT trace_id, toUnixTimestamp64Milli(trace_time) AS trace_time_ms,
               toString({_SAMPLE_KEY_SQL}) AS sample_key
        FROM (
            SELECT project_id, trace_id,
                   min(trace_start_time) AS trace_time,
                   max(ch_update_time) AS last_write
            FROM traces
            WHERE project_id = {{project_id:String}}
              AND trace_start_time >= {{since:DateTime64(3)}}
              AND trace_start_time < {{until:DateTime64(3)}}
            GROUP BY project_id, trace_id
            HAVING last_write <= {{idle_before:DateTime64(3)}}
        )
        WHERE trace_id NOT IN (
            SELECT trace_id FROM trace_task_digests
            WHERE project_id = {{project_id:String}} AND lens = {{lens:String}}
              AND trace_time >= {{since:DateTime64(3)}} AND trace_time < {{until:DateTime64(3)}}
        )
        ORDER BY {_SAMPLE_KEY_SQL} ASC, trace_id ASC
        LIMIT {{limit:UInt32}}
        """,
        parameters=params,
    )
    digested = ch.query(
        """
        SELECT count() FROM (
            SELECT trace_id FROM trace_task_digests
            WHERE project_id = {project_id:String} AND lens = {lens:String}
              AND trace_time >= {since:DateTime64(3)} AND trace_time < {until:DateTime64(3)}
            GROUP BY trace_id
        )
        """,
        parameters=params,
    )
    return {
        "data": [
            {"trace_id": tid, "trace_time_ms": int(ms), "key": key}
            for tid, ms, key in rows.result_rows
        ],
        "digested": int(digested.result_rows[0][0]),
    }


class DigestRow(BaseModel):
    trace_id: str = Field(min_length=1)
    trace_time_ms: int = Field(ge=0)
    summary: str = Field(min_length=1)
    embedding: list[float] = Field(min_length=1, max_length=MAX_EMBEDDING_DIMS)
    summary_model: str = Field(min_length=1)
    embedding_model: str = Field(min_length=1)
    digest_version: int = Field(ge=0, le=65535)
    cost_usd: float = Field(ge=0)


class DigestsPayload(BaseModel):
    project_id: str = Field(min_length=1)
    lens: str = DEFAULT_LENS
    rows: list[DigestRow] = Field(max_length=MAX_WRITE_ROWS)


@router.post("/digests", dependencies=[Depends(verify_internal_secret)])
def write_digests(body: DigestsPayload):
    """Store summaries and their embeddings. Rewriting a trace replaces its row."""
    columns = [
        "project_id",
        "trace_id",
        "lens",
        "trace_time",
        "summary",
        "embedding",
        "summary_model",
        "embedding_model",
        "digest_version",
        "cost_usd",
    ]
    get_clickhouse_client().insert_rows(
        "trace_task_digests",
        columns,
        [
            [
                body.project_id,
                r.trace_id,
                body.lens,
                _ms_to_utc(r.trace_time_ms),
                r.summary,
                r.embedding,
                r.summary_model,
                r.embedding_model,
                r.digest_version,
                r.cost_usd,
            ]
            for r in body.rows
        ],
    )
    return {"ok": True, "written": len(body.rows)}


@router.get("/current-groups", dependencies=[Depends(verify_internal_secret)])
def current_groups(project_id: str, lens: str = DEFAULT_LENS):
    """The groups of the project's latest fit, with what assignment needs.

    Returns:
        dict: ``{"fit_id": str | None, "data": [{group_id, name, center, reach, size}]}``.
    """
    ch = get_clickhouse_client()
    result = ch.query(
        """
        SELECT fit_id, group_id, name, center, reach, size
        FROM task_groups
        WHERE project_id = {project_id:String} AND lens = {lens:String}
          AND fit_id = (
              SELECT argMax(fit_id, fitted_at) FROM task_groups
              WHERE project_id = {project_id:String} AND lens = {lens:String}
          )
        ORDER BY group_id
        """,
        parameters={"project_id": project_id, "lens": lens},
    )
    rows = result.result_rows
    return {
        "fit_id": rows[0][0] if rows else None,
        "data": [
            {
                "group_id": gid,
                "name": name,
                "center": list(center),
                "reach": float(reach),
                "size": int(size),
            }
            for _fit, gid, name, center, reach, size in rows
        ],
    }


@router.get("/unplaced", dependencies=[Depends(verify_internal_secret)])
def list_unplaced(
    project_id: str,
    fit_id: str,
    limit: int = Query(200, ge=1, le=MAX_CANDIDATES),
    lens: str = DEFAULT_LENS,
):
    """Digested traces with no membership row under ``fit_id`` yet, oldest first."""
    result = get_clickhouse_client().query(
        """
        SELECT trace_id, toUnixTimestamp64Milli(trace_time) AS trace_time_ms, embedding
        FROM trace_task_digests FINAL
        WHERE project_id = {project_id:String} AND lens = {lens:String}
          AND trace_id NOT IN (
              SELECT trace_id FROM trace_group_members FINAL
              WHERE project_id = {project_id:String} AND lens = {lens:String}
                AND fit_id = {fit_id:String}
          )
        ORDER BY trace_time, trace_id
        LIMIT {limit:UInt32}
        """,
        parameters={"project_id": project_id, "lens": lens, "fit_id": fit_id, "limit": limit},
    )
    return {
        "data": [
            {"trace_id": tid, "trace_time_ms": int(ms), "embedding": list(emb)}
            for tid, ms, emb in result.result_rows
        ]
    }


class MemberRow(BaseModel):
    trace_id: str = Field(min_length=1)
    trace_time_ms: int = Field(ge=0)
    # Empty: the trace is in no group.
    group_id: str
    distance: float = Field(ge=0)


class MembersPayload(BaseModel):
    project_id: str = Field(min_length=1)
    lens: str = DEFAULT_LENS
    fit_id: str = Field(min_length=1)
    source: str = Field(pattern="^(assigned|fit)$")
    rows: list[MemberRow] = Field(max_length=MAX_WRITE_ROWS)


@router.post("/members", dependencies=[Depends(verify_internal_secret)])
def write_members(body: MembersPayload):
    """Record which group each trace is in. A later row for a trace replaces the earlier."""
    now = datetime.now(UTC)
    columns = [
        "project_id",
        "lens",
        "trace_id",
        "trace_time",
        "group_id",
        "fit_id",
        "distance",
        "source",
        "assigned_at",
    ]
    get_clickhouse_client().insert_rows(
        "trace_group_members",
        columns,
        [
            [
                body.project_id,
                body.lens,
                r.trace_id,
                _ms_to_utc(r.trace_time_ms),
                r.group_id,
                body.fit_id,
                r.distance,
                body.source,
                now,
            ]
            for r in body.rows
        ],
    )
    return {"ok": True, "written": len(body.rows)}
