"""Unit tests for scripts/backfill_signal_trace_times.py:

- the script must run from a standard checkout without the operator setting
  PYTHONPATH=backend by hand (#21);
- a large repair must not re-scan the project's whole retained trace history
  once per Postgres page (#20).
"""

import subprocess
import sys
import sysconfig
from datetime import datetime
from pathlib import Path
from unittest.mock import MagicMock

REPO_ROOT = Path(__file__).resolve().parent.parent
SCRIPT = REPO_ROOT / "scripts" / "backfill_signal_trace_times.py"

from scripts.backfill_signal_trace_times import repair  # noqa: E402


def test_runs_without_pythonpath_set():
    """Run with site init disabled (so this venv's own editable install can't
    quietly add `backend` to sys.path) and only this venv's site-packages on
    PYTHONPATH, which is what a plain `python scripts/...` invocation from a
    standard checkout looks like. The script must still find `db` itself.
    """
    site_packages = sysconfig.get_paths()["purelib"]
    result = subprocess.run(
        [sys.executable, "-S", str(SCRIPT), "--help"],
        cwd=REPO_ROOT,
        env={"PATH": "/usr/bin:/bin", "PYTHONPATH": site_packages},
        capture_output=True,
        text=True,
    )
    assert result.returncode == 0, result.stderr
    assert "--project-id" in result.stdout


class _FakeCursor:
    """Minimal cursor stub: hands back one canned page per SELECT, and
    acknowledges every UPDATE as having touched one row."""

    def __init__(self, conn):
        self._conn = conn
        self.rowcount = 0
        self._rows: list[tuple] = []

    def __enter__(self):
        return self

    def __exit__(self, *exc_info):
        return False

    def execute(self, query, params=None):
        statement = " ".join(query.split())
        if statement.startswith("SELECT run_id"):
            self._rows = self._conn.pages.pop(0) if self._conn.pages else []
        elif statement.startswith("UPDATE signal_hits"):
            self.rowcount = 1

    def fetchall(self):
        return self._rows


class _FakeConnection:
    """Postgres stand-in: `pages` is consumed one keyset page at a time,
    exactly like the real cursor would return one page per SELECT."""

    def __init__(self, pages):
        self.pages = [list(page) for page in pages]
        self.commits = 0
        self.rollbacks = 0

    def cursor(self):
        return _FakeCursor(self)

    def commit(self):
        self.commits += 1

    def rollback(self):
        self.rollbacks += 1


class _FakeClickHouse:
    """Records the trace-id set of every lookup so the test can assert how
    many separate ClickHouse round trips a repair actually took."""

    def __init__(self, known_times):
        self._known_times = known_times
        self.calls: list[set] = []

    def query(self, _sql, parameters):
        trace_ids = parameters["trace_ids"]
        self.calls.append(set(trace_ids))
        rows = [(tid, self._known_times[tid]) for tid in trace_ids if tid in self._known_times]
        result = MagicMock()
        result.result_rows = rows
        return result


def _paged_signal_hits(num_pages, rows_per_page):
    """`num_pages` pages of `rows_per_page` rows each, every row a distinct,
    never-before-seen trace id with no existing snapshot (NULL previous)."""
    pages = []
    run_id = 0
    for _page in range(num_pages):
        rows = []
        for _ in range(rows_per_page):
            run_id += 1
            rows.append((run_id, f"t{run_id}", None))
        pages.append(rows)
    return pages


def test_lookup_batches_several_pages_into_one_clickhouse_call():
    """10 Postgres pages of 5 rows each (50 distinct trace ids). With a
    lookup batch of 20 ids, that should take ~3 ClickHouse calls, not one
    per page (10) — the whole point of buffering several pages together."""
    pages = _paged_signal_hits(num_pages=10, rows_per_page=5)
    all_trace_ids = {row[1] for page in pages for row in page}
    pg = _FakeConnection(pages)
    ch = _FakeClickHouse({tid: datetime(2026, 1, 1) for tid in all_trace_ids})

    counts = repair(pg, ch, "p1", batch_size=5, lookup_batch_size=20)

    assert counts["scanned"] == 50
    assert len(ch.calls) <= 3, f"expected lookups batched across pages, got {len(ch.calls)} calls"
    # Every id is still looked up exactly once, batching only changes the grouping.
    assert set().union(*ch.calls) == all_trace_ids


def test_lookup_batching_preserves_per_page_commit_granularity():
    """Postgres commits/rolls back once per original page regardless of how
    many pages a ClickHouse lookup batch spans, so a crash mid-repair loses
    at most one page of progress."""
    pages = _paged_signal_hits(num_pages=4, rows_per_page=3)
    all_trace_ids = {row[1] for page in pages for row in page}
    pg = _FakeConnection(pages)
    ch = _FakeClickHouse({tid: datetime(2026, 1, 1) for tid in all_trace_ids})

    repair(pg, ch, "p1", apply=False, batch_size=3, lookup_batch_size=100)

    assert pg.rollbacks == 4
    assert pg.commits == 0


def test_apply_commits_each_page_and_counts_the_updates():
    """The write path commits once per Postgres page, whatever the lookup batch."""
    pages = _paged_signal_hits(num_pages=4, rows_per_page=3)
    all_trace_ids = {row[1] for page in pages for row in page}
    pg = _FakeConnection(pages)
    ch = _FakeClickHouse({tid: datetime(2026, 1, 1) for tid in all_trace_ids})

    counts = repair(pg, ch, "p1", apply=True, batch_size=3, lookup_batch_size=100)

    assert pg.commits == 4
    assert pg.rollbacks == 0
    assert counts["updated"] == 12


def test_buffer_is_bounded_by_rows_when_hits_share_few_traces():
    """Many hits on one trace never reach the id bound; the row bound still
    flushes, so the repair does not hold every page until the end."""
    pages = [[(page * 5 + i, "t-shared", None) for i in range(1, 6)] for page in range(10)]
    pg = _FakeConnection(pages)
    ch = _FakeClickHouse({"t-shared": datetime(2026, 1, 1)})

    counts = repair(pg, ch, "p1", batch_size=5, lookup_batch_size=10)

    assert counts["scanned"] == 50
    # Two pages (10 rows) per lookup.
    assert len(ch.calls) == 5
