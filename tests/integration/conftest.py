"""Live ClickHouse fixtures for the SQL gateway integration suite.

The suite runs only when ``SQL_GATEWAY_IT_CLICKHOUSE_HOST`` is set, and it must point at a
THROWAWAY server. It drops and recreates one database, and it provisions the gateway
accounts from the repository's own bootstrap SQL, which are server-wide ClickHouse access
entities: ``sql_gateway_writer`` (the DEFINER that migration 012 names, so the name cannot
change), ``sql_gateway_ro`` and ``sql_readonly_profile`` are dropped and recreated on every
run. Never aim it at a server whose gateway accounts anything else relies on.

Environment:

* ``SQL_GATEWAY_IT_CLICKHOUSE_HOST``: required to run; the suite skips when it is unset.
* ``SQL_GATEWAY_IT_REQUIRED``: set in CI. The suite then fails instead of skipping when the
  host is unset, so renaming the variable on one side cannot leave a green job that ran
  nothing.
* ``SQL_GATEWAY_IT_CLICKHOUSE_PORT``: HTTP port, default ``8123``.
* ``SQL_GATEWAY_IT_CLICKHOUSE_USER`` / ``SQL_GATEWAY_IT_CLICKHOUSE_PASSWORD``: an admin that
  can create databases, users and settings profiles and set a view DEFINER. Default
  ``default`` with an empty password.

Once the host is set, an unreachable server is a failure rather than a skip: a suite that
quietly skips in the one environment that configured it proves nothing.
"""

from __future__ import annotations

import hashlib
import os
import secrets
from collections.abc import Iterator
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from pathlib import Path

import clickhouse_connect
import pytest
from clickhouse_connect.driver.client import Client

from db.clickhouse.client import ClickHouseClient

ROOT = Path(__file__).resolve().parents[2]
MIGRATIONS = ROOT / "backend" / "db" / "clickhouse" / "migrations"
BOOTSTRAP = ROOT / "backend" / "db" / "clickhouse" / "bootstrap"

DATABASE = "sqlgw_it"
HOST = os.environ.get("SQL_GATEWAY_IT_CLICKHOUSE_HOST", "")
PORT = int(os.environ.get("SQL_GATEWAY_IT_CLICKHOUSE_PORT", "8123"))
ADMIN_USER = os.environ.get("SQL_GATEWAY_IT_CLICKHOUSE_USER", "default")
ADMIN_PASSWORD = os.environ.get("SQL_GATEWAY_IT_CLICKHOUSE_PASSWORD", "")
REQUIRED = bool(os.environ.get("SQL_GATEWAY_IT_REQUIRED"))

PROJECT_A = "proj_a"
PROJECT_B = "proj_b"
PROJECT_SEM = "proj_sem"
PROJECT_CAP = "proj_cap"

# The read-only profile caps result rows at this, CONST, in the bootstrap SQL.
PROFILE_MAX_RESULT_ROWS = 100_000

# Timezone-aware on purpose: clickhouse-connect reads a naive datetime as the CLIENT's
# local time, which moves every boundary row by the runner's UTC offset.
T0 = datetime(2026, 9, 1, 10, 0, 0, tzinfo=UTC)
V1 = datetime(2026, 9, 10, 0, 0, 0, tzinfo=UTC)
V2 = datetime(2026, 9, 11, 0, 0, 0, tzinfo=UTC)


def pytest_configure(config):
    config.addinivalue_line(
        "markers", "integration: needs a live ClickHouse (SQL_GATEWAY_IT_CLICKHOUSE_HOST)"
    )


def _statements(sql: str) -> list[str]:
    """Split a goose file or bootstrap script into statements, Up section only.

    Comment lines are dropped first: several carry semicolons in prose. No statement in
    these files puts a semicolon inside a string literal, which this split relies on.
    """
    sql = sql.split("-- +goose Down")[0]
    sql = "\n".join(line for line in sql.splitlines() if not line.lstrip().startswith("--"))
    return [s.strip() for s in sql.split(";") if s.strip()]


def _connect(username: str, password: str, database: str | None = None) -> Client:
    return clickhouse_connect.get_client(
        host=HOST,
        port=PORT,
        username=username,
        password=password,
        database=database or "",
        autogenerate_session_id=False,
    )


@dataclass(frozen=True)
class Seeded:
    """What was written per project, so every assertion compares against known ids."""

    spans: dict[str, set[str]]
    traces: dict[str, set[str]]


@dataclass
class Gateway:
    admin: Client
    ro: ClickHouseClient
    seeded: Seeded


def _span(project, span_id, trace_id, start, **kw):
    return {
        "span_id": span_id,
        "trace_id": trace_id,
        "parent_span_id": kw.get("parent"),
        "project_id": project,
        "span_start_time": start,
        "span_end_time": start + timedelta(milliseconds=kw.get("duration_ms", 250)),
        "name": kw.get("name", f"{span_id}-name"),
        "span_kind": kw.get("kind", "LLM"),
        "status": "OK",
        "model_name": kw.get("model", "gpt-test"),
        "input_tokens": 10,
        "output_tokens": 20,
        "total_tokens": 30,
        "metadata": kw.get("metadata", '{"tier": "pro"}'),
        "source": kw.get("source", "user"),
        "is_evaluation": kw.get("is_evaluation", 0),
        "ch_update_time": kw.get("updated", V1),
    }


def _trace(project, trace_id, start, **kw):
    return {
        "trace_id": trace_id,
        "project_id": project,
        "trace_start_time": start,
        "name": kw.get("name", f"{trace_id}-name"),
        "user_id": "user-1",
        "session_id": "session-1",
        "metadata": '{"env": "test"}',
        "source": kw.get("source", "user"),
        "is_evaluation": kw.get("is_evaluation", 0),
        "ch_update_time": kw.get("updated", V1),
    }


def _insert(admin: Client, table: str, rows: list[dict]) -> None:
    columns = list(rows[0])
    admin.insert(table, [[r[c] for c in columns] for r in rows], column_names=columns)


def _seed(admin: Client) -> Seeded:
    spans: dict[str, set[str]] = {}
    traces: dict[str, set[str]] = {}

    # Two tenants with different sizes and disjoint id prefixes, so a leak shows up both as
    # a foreign id and as a wrong count.
    for project, prefix, n_traces in ((PROJECT_A, "a", 10), (PROJECT_B, "b", 12)):
        trace_rows, span_rows = [], []
        for i in range(n_traces):
            trace_id = f"{prefix}-t{i}"
            start = T0 + timedelta(days=i % 4)
            trace_rows.append(_trace(project, trace_id, start))
            for j in range(3):
                span_id = f"{trace_id}-s{j}"
                parent = None if j == 0 else f"{trace_id}-s0"
                kind = "LLM" if j == 1 else "CHAIN"
                span_rows.append(
                    _span(
                        project,
                        span_id,
                        trace_id,
                        start + timedelta(seconds=j),
                        parent=parent,
                        kind=kind,
                    )
                )
        _insert(admin, "traces", trace_rows)
        _insert(admin, "spans", span_rows)
        traces[project] = {r["trace_id"] for r in trace_rows}
        spans[project] = {r["span_id"] for r in span_rows}

    # Semantics tenant. Each case is inserted separately so versions land in different
    # parts and a merge has something to collapse.
    sem = PROJECT_SEM
    _insert(admin, "traces", [_trace(sem, "sem-user", T0)])
    boundary = {
        "sem-b0831": datetime(2026, 8, 31, 23, 59, 59, 999000, tzinfo=UTC),
        "sem-b0901": datetime(2026, 9, 1, 0, 0, 0, tzinfo=UTC),
        "sem-b0901h": datetime(2026, 9, 1, 0, 0, 0, 500000, tzinfo=UTC),
        "sem-b0904": datetime(2026, 9, 4, 23, 59, 59, 999000, tzinfo=UTC),
        "sem-b0905": datetime(2026, 9, 5, 0, 0, 0, tzinfo=UTC),
    }
    _insert(admin, "spans", [_span(sem, sid, "sem-user", ts) for sid, ts in boundary.items()])

    # One span, corrected later to a different start time: different sort keys, so no
    # merge ever collapses the two versions and only the view's dedup can.
    _insert(
        admin,
        "spans",
        [_span(sem, "sem-dedup", "sem-user", T0 + timedelta(days=1), name="v1", updated=V1)],
    )
    _insert(
        admin,
        "spans",
        [
            _span(
                sem,
                "sem-dedup",
                "sem-user",
                T0 + timedelta(days=1, minutes=5),
                name="v2",
                updated=V2,
            )
        ],
    )

    # Internal traffic, and a span retracted to internal by a newer version.
    _insert(admin, "traces", [_trace(sem, "sem-internal", T0, source="internal")])
    _insert(admin, "spans", [_span(sem, "sem-internal-s0", "sem-internal", T0, source="internal")])
    _insert(admin, "spans", [_span(sem, "sem-retract", "sem-user", T0, updated=V1)])
    _insert(
        admin, "spans", [_span(sem, "sem-retract", "sem-user", T0, source="internal", updated=V2)]
    )

    # An evaluation trace whose trace row is later rewritten unflagged on the same day, so a
    # merge physically deletes the flagged version. The scorer span keeps the flag.
    _insert(admin, "traces", [_trace(sem, "sem-eval", T0, is_evaluation=1, updated=V1)])
    _insert(admin, "traces", [_trace(sem, "sem-eval", T0, is_evaluation=0, updated=V2)])
    _insert(
        admin,
        "spans",
        [
            _span(sem, "sem-eval-scorer", "sem-eval", T0, kind="EVALUATOR", is_evaluation=1),
            _span(
                sem,
                "sem-eval-child",
                "sem-eval",
                T0 + timedelta(seconds=1),
                parent="sem-eval-scorer",
            ),
        ],
    )

    # Enough rows to exceed the profile's result-row cap.
    admin.command(
        f"INSERT INTO spans (span_id, trace_id, project_id, span_start_time, name, span_kind, usage_details) "
        f"SELECT concat('cap-s', toString(number)), 'cap-t0', '{PROJECT_CAP}', "
        f"toDateTime64('2026-09-02 00:00:00', 3), 'n', 'CHAIN', map() "
        f"FROM numbers({PROFILE_MAX_RESULT_ROWS + 50})"
    )
    return Seeded(spans=spans, traces=traces)


@pytest.fixture(scope="session")
def gateway() -> Iterator[Gateway]:
    if not HOST:
        if REQUIRED:
            pytest.fail("SQL_GATEWAY_IT_REQUIRED is set but SQL_GATEWAY_IT_CLICKHOUSE_HOST is not")
        pytest.skip("SQL_GATEWAY_IT_CLICKHOUSE_HOST is not set")

    root = _connect(ADMIN_USER, ADMIN_PASSWORD)
    # Accounts are dropped as well as the database. Grants are recorded by name and outlive
    # the objects they name, so a grant left by an earlier run would silently hand this run
    # a read-only account with more access than the bootstrap script gives it.
    # The database goes first, since its views name the writer as their DEFINER.
    root.command(f"DROP DATABASE IF EXISTS {DATABASE}")
    root.command("DROP USER IF EXISTS sql_gateway_ro, sql_gateway_writer")
    root.command("DROP SETTINGS PROFILE IF EXISTS sql_readonly_profile")
    root.command(f"CREATE DATABASE {DATABASE}")
    admin = _connect(ADMIN_USER, ADMIN_PASSWORD, DATABASE)

    # Accounts first, exactly as clickhouse-init does: migration 012 names the writer as
    # the views' DEFINER, and grants are name-based so they precede the objects.
    # Every bootstrap script, in the order clickhouse-init runs them. The read-only account
    # lives in sql_gateway_users.sql or in its own sql_gateway_readonly.sql depending on the
    # revision, so the files are read if present and the account is then required to exist,
    # rather than this fixture hardcoding where it is defined.
    ro_password = secrets.token_hex(16)
    for name in ("sql_gateway_users.sql", "sql_gateway_readonly.sql"):
        path = BOOTSTRAP / name
        if not path.exists():
            continue
        script = (
            path.read_text()
            .replace("__WRITER_HASH__", hashlib.sha256(secrets.token_bytes(32)).hexdigest())
            .replace("__RO_HASH__", hashlib.sha256(ro_password.encode()).hexdigest())
            .replace("__DB__", DATABASE)
        )
        for statement in _statements(script):
            admin.command(statement)
    provisioned = {row[0] for row in root.query("SELECT name FROM system.users").result_rows}
    assert {"sql_gateway_writer", "sql_gateway_ro"} <= provisioned, (
        f"the bootstrap SQL did not create both gateway accounts: {sorted(provisioned)}"
    )

    for migration in sorted(MIGRATIONS.glob("[0-9]*.sql")):
        for statement in _statements(migration.read_text()):
            admin.command(statement)

    seeded = _seed(admin)
    ro = ClickHouseClient(_connect("sql_gateway_ro", ro_password, DATABASE))
    try:
        yield Gateway(admin=admin, ro=ro, seeded=seeded)
    finally:
        ro.close()
        root.command(f"DROP DATABASE IF EXISTS {DATABASE}")
        admin.close()
        root.close()
