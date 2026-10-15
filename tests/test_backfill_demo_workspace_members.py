"""Unit tests for scripts/backfill_demo_workspace_members.py."""

import subprocess
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent
SCRIPT = REPO_ROOT / "scripts" / "backfill_demo_workspace_members.py"

from scripts.backfill_demo_workspace_members import INSERT_SQL, backfill  # noqa: E402


class _FakeCursor:
    def __init__(self, workspace_exists=True, missing=3):
        self.workspace_exists = workspace_exists
        self.missing = missing
        self.executed = []
        self.rowcount = 0
        self._result = []

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def execute(self, query, params=None):
        self.executed.append(query)
        if "FROM workspaces" in query:
            self._result = [(1,)] if self.workspace_exists else []
        elif query is INSERT_SQL:
            self.rowcount = self.missing
        else:
            self._result = [(self.missing,)]

    def fetchone(self):
        return self._result[0] if self._result else None

    def fetchall(self):
        return self._result


class _FakeConnection:
    def __init__(self, cursor):
        self._cursor = cursor
        self.committed = False
        self.rolled_back = False

    def cursor(self):
        return self._cursor

    def commit(self):
        self.committed = True

    def rollback(self):
        self.rolled_back = True


def test_dry_run_counts_and_writes_nothing():
    cursor = _FakeCursor(missing=3)
    pg = _FakeConnection(cursor)
    assert backfill(pg, "ws-demo") == (3, 0)
    assert INSERT_SQL not in cursor.executed
    assert pg.rolled_back and not pg.committed


def test_apply_inserts_viewers_without_touching_existing_members():
    cursor = _FakeCursor(missing=3)
    pg = _FakeConnection(cursor)
    assert backfill(pg, "ws-demo", apply=True) == (3, 3)
    assert INSERT_SQL in cursor.executed
    assert pg.committed
    # Existing members keep their role: the insert skips them instead of updating.
    assert "'VIEWER'" in INSERT_SQL
    assert "ON CONFLICT (workspace_id, user_id) DO NOTHING" in INSERT_SQL


def test_refuses_a_workspace_that_does_not_exist():
    pg = _FakeConnection(_FakeCursor(workspace_exists=False))
    with pytest.raises(SystemExit):
        backfill(pg, "ws-missing", apply=True)
    assert not pg.committed


def test_script_help_smoke():
    result = subprocess.run(
        [sys.executable, str(SCRIPT), "--help"],
        cwd=REPO_ROOT,
        capture_output=True,
        text=True,
    )
    assert result.returncode == 0, result.stderr
    assert "--workspace-id" in result.stdout
