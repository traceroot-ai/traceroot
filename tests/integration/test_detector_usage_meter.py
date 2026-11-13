"""The detector-scan meter against a live ClickHouse (#2033).

The unit suite (``tests/rest/test_detector_endpoints.py``) pins the endpoint's
plumbing against a mock that mirrors the collapse; this suite proves the real
SQL agrees with that mirror — ReplacingMergeTree versioning, the argMax
collapse, and the ``used_inference`` column from migration 016 — both before
and after a physical merge.

Seeds versioned ``detector_runs`` rows in its own project ids and points
``usage.get_clickhouse_client`` at the live admin client, so the endpoint
function runs its SQL unmodified against the throwaway server.
"""

from __future__ import annotations

import asyncio
from datetime import UTC, datetime

import pytest

import rest.routers.internal.usage as usage
from db.clickhouse.client import ClickHouseClient

from .conftest import Gateway, _insert

pytestmark = pytest.mark.integration

PROJECT = "it_meter"
OTHER_PROJECT = "it_meter_other"
START = datetime(2026, 4, 1, tzinfo=UTC)
END = datetime(2026, 5, 1, tzinfo=UTC)
AT = datetime(2026, 4, 10, 10, 0, tzinfo=UTC)
# Every version gets a distinct timestamp: ReplacingMergeTree keeps one row
# arbitrarily when two versions tie on both the sort key and the version
# column, so a tie would make the post-merge count non-deterministic.
LATER = datetime(2026, 4, 10, 10, 5, tzinfo=UTC)

#: One row per run: (run_id, status, used_inference, timestamp).
RUNS = [
    ("completed", "completed", False, AT),  # counts by status
    ("stale-completed", "completed", False, AT),
    ("failed-billed", "failed", True, AT),  # the fix: burned calls, still a scan
    ("stale-completed-billed", "completed", False, AT),
    ("billed-stale-unbilled-latest", "failed", True, AT),
    ("legacy-failed", "failed", False, AT),  # pre-016 shape → no
    ("at-start", "completed", False, START),  # inclusive bound → counts
    ("at-end", "completed", False, END),  # exclusive bound → no
]
#: The later version of each retried run, written in its own insert so it
#: lands in a separate part — the pre-merge state a BullMQ retry leaves
#: behind. ReplacingMergeTree only collapses across parts on a merge.
RETRIES = [
    ("stale-completed", "failed", False, LATER),  # latest failed, unbilled → no
    ("stale-completed-billed", "failed", True, LATER),  # latest failed, billed → counts
    ("billed-stale-unbilled-latest", "failed", False, LATER),  # latest supersedes → no
]
EXPECTED = 4
ROWS_BEFORE_MERGE = len(RUNS) + len(RETRIES)
DISTINCT_RUNS = len(RUNS)


def _run_row(run_id: str, status: str, used_inference: bool, ts: datetime, project: str) -> dict:
    return {
        "run_id": run_id,
        "detector_id": "d1",
        "project_id": project,
        "trace_id": f"trace-{run_id}",
        "finding_id": None,
        "status": status,
        "timestamp": ts,
        "used_inference": used_inference,
    }


@pytest.fixture(scope="module")
def seeded(gateway: Gateway) -> Gateway:
    _insert(
        gateway.admin,
        "detector_runs",
        [_run_row(run_id, status, used, ts, PROJECT) for run_id, status, used, ts in RUNS],
    )
    _insert(
        gateway.admin,
        "detector_runs",
        [_run_row(run_id, status, used, ts, PROJECT) for run_id, status, used, ts in RETRIES],
    )
    # A foreign project's billed failure must not leak into the count.
    _insert(
        gateway.admin,
        "detector_runs",
        [_run_row("other-failed-billed", "failed", True, AT, OTHER_PROJECT)],
    )
    return gateway


def _meter_count(gateway: Gateway, monkeypatch) -> int:
    monkeypatch.setattr(usage, "get_clickhouse_client", lambda: ClickHouseClient(gateway.admin))
    result = asyncio.run(usage.get_usage_details(project_ids=PROJECT, start=START, end=END))
    return result.detector_runs


def _physical_rows(gateway: Gateway) -> int:
    return gateway.admin.query(
        "SELECT count() FROM detector_runs WHERE project_id = {p:String}",
        parameters={"p": PROJECT},
    ).result_rows[0][0]


def test_the_real_query_counts_completed_and_billed_failed_runs(seeded, monkeypatch):
    """Before any merge: the query's own argMax must collapse across parts."""
    assert _physical_rows(seeded) == ROWS_BEFORE_MERGE
    assert _meter_count(seeded, monkeypatch) == EXPECTED


def test_the_count_is_unchanged_by_a_physical_merge(seeded, monkeypatch):
    """After OPTIMIZE FINAL the versions physically collapse; the count must not move."""
    seeded.admin.command("OPTIMIZE TABLE detector_runs FINAL")
    assert _physical_rows(seeded) == DISTINCT_RUNS, "the merge did not collapse the versions"
    assert _meter_count(seeded, monkeypatch) == EXPECTED
