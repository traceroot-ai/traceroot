"""Reads and writes for the fit: ClickHouse for summaries, groups and memberships,
Postgres for the switch, the run ledger and the refresh handshake.

Every query is scoped by project id.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from datetime import UTC, date, datetime, timedelta

import numpy as np

from db.clickhouse.client import get_clickhouse_client
from shared.config import settings

LENS = "task"
# Summaries older than this are not part of a fit.
FIT_WINDOW_DAYS = 14
# The most recent summaries a single fit reads.
MAX_FIT_ROWS = 50_000
WRITE_CHUNK = 2_000
# A run that has been "running" this long is taken to have died with its worker.
STALE_RUNNING = timedelta(minutes=30)
MAX_ATTEMPTS = 3


def window_start(now: datetime) -> datetime:
    return now - timedelta(days=FIT_WINDOW_DAYS)


@dataclass
class Window:
    trace_ids: list[str]
    trace_times: list[datetime]
    summaries: list[str]
    vectors: np.ndarray


@dataclass
class PreviousFit:
    fit_id: str | None
    groups: dict[str, dict]  # group_id -> {name, description, size}
    members: dict[str, set[str]]  # group_id -> trace ids
    known: set[str]  # every trace placed under that fit, grouped or not


def count_window(project_id: str, now: datetime) -> int:
    result = get_clickhouse_client().query(
        """
        SELECT count() FROM (
            SELECT trace_id FROM trace_task_digests
            WHERE project_id = {p:String} AND lens = {lens:String} AND trace_time >= {since:DateTime64(3)}
            GROUP BY trace_id
        )
        """,
        parameters={"p": project_id, "lens": LENS, "since": window_start(now)},
    )
    return int(result.result_rows[0][0])


def load_window(project_id: str, now: datetime) -> Window:
    """Latest summary of each trace in the window, newest ``MAX_FIT_ROWS``, in trace id order."""
    result = get_clickhouse_client().query(
        """
        SELECT trace_id, trace_time, summary, embedding FROM (
            SELECT trace_id, trace_time, summary, embedding
            FROM trace_task_digests FINAL
            WHERE project_id = {p:String} AND lens = {lens:String} AND trace_time >= {since:DateTime64(3)}
            ORDER BY trace_time DESC, trace_id
            LIMIT {limit:UInt32}
        ) ORDER BY trace_id
        """,
        parameters={
            "p": project_id,
            "lens": LENS,
            "since": window_start(now),
            "limit": MAX_FIT_ROWS,
        },
    )
    rows = result.result_rows
    return Window(
        trace_ids=[r[0] for r in rows],
        trace_times=[r[1] for r in rows],
        summaries=[r[2] for r in rows],
        vectors=np.array([r[3] for r in rows], dtype=np.float32).reshape(len(rows), -1),
    )


def load_previous(project_id: str) -> PreviousFit:
    ch = get_clickhouse_client()
    groups = ch.query(
        """
        SELECT fit_id, group_id, name, description, size FROM task_groups
        WHERE project_id = {p:String} AND lens = {lens:String}
          AND fit_id = (SELECT argMax(fit_id, fitted_at) FROM task_groups
                        WHERE project_id = {p:String} AND lens = {lens:String})
        """,
        parameters={"p": project_id, "lens": LENS},
    ).result_rows
    if not groups:
        return PreviousFit(None, {}, {}, set())
    fit_id = groups[0][0]
    rows = ch.query(
        """
        SELECT trace_id, group_id FROM trace_group_members FINAL
        WHERE project_id = {p:String} AND lens = {lens:String} AND fit_id = {fit:String}
        """,
        parameters={"p": project_id, "lens": LENS, "fit": fit_id},
    ).result_rows
    members: dict[str, set[str]] = {}
    known: set[str] = set()
    for trace_id, group_id in rows:
        known.add(trace_id)
        if group_id:
            members.setdefault(group_id, set()).add(trace_id)
    return PreviousFit(
        fit_id,
        {g[1]: {"name": g[2], "description": g[3], "size": g[4]} for g in groups},
        members,
        known,
    )


def write_fit(
    project_id: str,
    *,
    fit_id: str,
    window: Window,
    group_ids: list[str],
    labels: np.ndarray,
    distances: np.ndarray,
    groups: list[dict],
    now: datetime,
) -> None:
    """Write memberships first, then the groups, so a fit becomes current only when whole."""
    ch = get_clickhouse_client()
    member_cols = [
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
    rows = [
        [
            project_id,
            LENS,
            window.trace_ids[i],
            window.trace_times[i],
            group_ids[labels[i]] if labels[i] >= 0 else "",
            fit_id,
            float(distances[i]),
            "fit",
            now,
        ]
        for i in range(len(window.trace_ids))
    ]
    for start in range(0, len(rows), WRITE_CHUNK):
        ch.insert_rows("trace_group_members", member_cols, rows[start : start + WRITE_CHUNK])
    group_cols = [
        "project_id",
        "lens",
        "fit_id",
        "group_id",
        "name",
        "description",
        "center",
        "reach",
        "size",
        "exemplar_trace_ids",
        "fitted_at",
    ]
    ch.insert_rows(
        "task_groups",
        group_cols,
        [
            [
                project_id,
                LENS,
                fit_id,
                g["group_id"],
                g["name"],
                g["description"],
                [float(x) for x in g["center"]],
                float(g["reach"]),
                int(g["size"]),
                g["exemplar_trace_ids"],
                now,
            ]
            for g in groups
        ],
    )


# --- Postgres ----------------------------------------------------------------


def _connect():
    import psycopg2

    return psycopg2.connect(settings.database_url)


def enabled_projects() -> list[str]:
    with _connect() as conn, conn.cursor() as cur:
        cur.execute("SELECT project_id FROM task_group_settings WHERE enabled ORDER BY project_id")
        return [r[0] for r in cur.fetchall()]


def is_enabled(project_id: str) -> bool:
    with _connect() as conn, conn.cursor() as cur:
        cur.execute("SELECT enabled FROM task_group_settings WHERE project_id = %s", (project_id,))
        row = cur.fetchone()
        return bool(row and row[0])


def refresh_pending(project_id: str) -> bool:
    with _connect() as conn, conn.cursor() as cur:
        cur.execute(
            """
            SELECT refresh_requested_at IS NOT NULL
               AND (last_refresh_at IS NULL OR refresh_requested_at > last_refresh_at)
            FROM task_group_settings WHERE project_id = %s AND enabled
            """,
            (project_id,),
        )
        row = cur.fetchone()
        return bool(row and row[0])


def daily_due(project_id: str, today: date) -> bool:
    """True when no daily run has claimed today, or the claim failed (or died) with attempts left."""
    with _connect() as conn, conn.cursor() as cur:
        cur.execute(
            """
            SELECT status, attempts, started_at < now() - %s FROM task_group_fit_runs
            WHERE project_id = %s AND trigger = 'daily' AND run_day = %s
            """,
            (STALE_RUNNING, project_id, today),
        )
        row = cur.fetchone()
    if row is None:
        return True
    status, attempts, stale = row
    return attempts < MAX_ATTEMPTS and (status == "failed" or (status == "running" and stale))


def claim_daily(project_id: str, today: date) -> str | None:
    """Claim today's daily run. Exactly one caller gets an id; the rest get None."""
    run_id = uuid.uuid4().hex
    with _connect() as conn, conn.cursor() as cur:
        cur.execute(
            """
            INSERT INTO task_group_fit_runs (id, project_id, trigger, run_day, status, attempts)
            VALUES (%s, %s, 'daily', %s, 'running', 1)
            ON CONFLICT (project_id, run_day) WHERE trigger = 'daily'
            DO UPDATE SET status = 'running', attempts = task_group_fit_runs.attempts + 1,
                          started_at = now(), finished_at = NULL, error = NULL
            WHERE task_group_fit_runs.attempts < %s
              AND (task_group_fit_runs.status = 'failed'
                   OR (task_group_fit_runs.status = 'running'
                       AND task_group_fit_runs.started_at < now() - %s))
            RETURNING id
            """,
            (run_id, project_id, today, MAX_ATTEMPTS, STALE_RUNNING),
        )
        row = cur.fetchone()
        return row[0] if row else None


def claim_refresh(project_id: str, today: date) -> str | None:
    """Consume a pending refresh request. Exactly one caller per request gets an id."""
    run_id = uuid.uuid4().hex
    with _connect() as conn, conn.cursor() as cur:
        cur.execute(
            """
            UPDATE task_group_settings SET last_refresh_at = now()
            WHERE project_id = %s AND enabled AND refresh_requested_at IS NOT NULL
              AND (last_refresh_at IS NULL OR refresh_requested_at > last_refresh_at)
            RETURNING 1
            """,
            (project_id,),
        )
        if cur.fetchone() is None:
            return None
        cur.execute(
            """
            INSERT INTO task_group_fit_runs (id, project_id, trigger, run_day, status, attempts)
            VALUES (%s, %s, 'refresh', %s, 'running', 1)
            """,
            (run_id, project_id, today),
        )
        return run_id


def finish_run(run_id: str, *, status: str, **fields) -> None:
    allowed = {"fit_id", "digest_count", "group_count", "noise_count", "duration_ms", "error"}
    columns = [k for k in fields if k in allowed]
    assignments = "".join(f", {c} = %s" for c in columns)
    with _connect() as conn, conn.cursor() as cur:
        cur.execute(
            f"UPDATE task_group_fit_runs SET status = %s, finished_at = now(){assignments} "
            "WHERE id = %s",
            (status, *[fields[c] for c in columns], run_id),
        )


def add_spend(project_id: str, day: date, cost_usd: float) -> None:
    with _connect() as conn, conn.cursor() as cur:
        cur.execute(
            """
            INSERT INTO task_group_spend_days (project_id, day, summaries, cost_usd)
            VALUES (%s, %s, 0, %s)
            ON CONFLICT (project_id, day)
            DO UPDATE SET cost_usd = task_group_spend_days.cost_usd + EXCLUDED.cost_usd,
                          update_time = now()
            """,
            (project_id, day, cost_usd),
        )


def utc_now() -> datetime:
    return datetime.now(UTC)
