"""Behavior tests for the legacy demo membership reset; no PostgreSQL is contacted."""

import sqlite3
import subprocess
import sys
from pathlib import Path

import pytest

from scripts import reset_demo_workspace_members as command
from scripts.reset_demo_workspace_members import DELETE_SQL, reset_memberships

REPO_ROOT = Path(__file__).resolve().parent.parent
SCRIPT = REPO_ROOT / "scripts" / "reset_demo_workspace_members.py"


class _Cursor:
    def __init__(self, pg):
        self.pg = pg
        self.cursor = pg.db.cursor()

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.cursor.close()

    def execute(self, query, params=None):
        self.pg.executed.append(query)
        if query == DELETE_SQL and self.pg.before_delete:
            self.pg.before_delete()
        # Exercise the actual SQL with SQLite's named-parameter spelling.
        self.cursor.execute(query.replace("%(workspace_id)s", ":workspace_id"), params or {})

    def fetchone(self):
        return self.cursor.fetchone()

    @property
    def rowcount(self):
        return self.cursor.rowcount


class _Connection:
    def __init__(self):
        self.db = sqlite3.connect(":memory:")
        self.executed = []
        self.commits = 0
        self.rollbacks = 0
        self.fail_commit = False
        self.before_delete = None
        self.closed = False

    def cursor(self):
        return _Cursor(self)

    def commit(self):
        if self.fail_commit:
            raise RuntimeError("commit failed")
        self.db.commit()
        self.commits += 1

    def rollback(self):
        self.db.rollback()
        self.rollbacks += 1

    def close(self):
        self.closed = True

    def memberships(self):
        return self.db.execute(
            "SELECT workspace_id, user_id, role FROM workspace_members ORDER BY user_id"
        ).fetchall()


@pytest.fixture
def pg(monkeypatch):
    monkeypatch.setenv("DEMO_WORKSPACE_ID", " ws-demo ")
    connection = _Connection()
    connection.db.executescript("""
        CREATE TABLE workspaces (id TEXT PRIMARY KEY);
        CREATE TABLE workspace_members (workspace_id TEXT, user_id TEXT, role TEXT);
        INSERT INTO workspaces VALUES ('ws-demo'), ('ws-own');
        INSERT INTO workspace_members VALUES
            ('ws-demo', 'viewer-1', 'VIEWER'),
            ('ws-demo', 'viewer-2', 'VIEWER'),
            ('ws-demo', 'admin', 'ADMIN'),
            ('ws-demo', 'member', 'MEMBER'),
            ('ws-own', 'viewer-1', 'VIEWER');
    """)
    yield connection
    connection.db.close()


def test_dry_run_counts_viewers_without_deleting(pg):
    before = pg.memberships()
    assert reset_memberships(pg, "ws-demo") == (2, 0)
    assert pg.memberships() == before
    assert DELETE_SQL not in pg.executed
    assert pg.rollbacks == 1
    assert pg.commits == 0


def test_apply_deletes_only_target_workspace_viewers_and_is_repeatable(pg):
    assert reset_memberships(pg, "ws-demo", apply=True) == (2, 2)
    assert pg.memberships() == [
        ("ws-demo", "admin", "ADMIN"),
        ("ws-demo", "member", "MEMBER"),
        ("ws-own", "viewer-1", "VIEWER"),
    ]
    assert reset_memberships(pg, "ws-demo", apply=True) == (0, 0)
    assert pg.commits == 2


def test_delete_rechecks_role_instead_of_removing_a_promoted_member(pg):
    pg.before_delete = lambda: pg.db.execute(
        "UPDATE workspace_members SET role = 'ADMIN' WHERE user_id = 'viewer-1'"
        " AND workspace_id = 'ws-demo'"
    )
    assert reset_memberships(pg, "ws-demo", apply=True) == (2, 1)
    assert ("ws-demo", "viewer-1", "ADMIN") in pg.memberships()


def test_commit_failure_rolls_back_the_deletions(pg):
    before = pg.memberships()
    pg.fail_commit = True
    with pytest.raises(RuntimeError, match="commit failed"):
        reset_memberships(pg, "ws-demo", apply=True)
    assert pg.memberships() == before
    assert pg.rollbacks == 1


@pytest.mark.parametrize("configured", ["", "ws-own"])
def test_refuses_an_unconfigured_or_different_workspace_before_queries(pg, monkeypatch, configured):
    monkeypatch.setenv("DEMO_WORKSPACE_ID", configured)
    with pytest.raises(ValueError, match="must match"):
        reset_memberships(pg, "ws-demo", apply=True)
    assert pg.executed == []


def test_refuses_a_configured_workspace_that_does_not_exist(pg, monkeypatch):
    monkeypatch.setenv("DEMO_WORKSPACE_ID", "ws-missing")
    with pytest.raises(ValueError, match="does not exist"):
        reset_memberships(pg, "ws-missing", apply=True)
    assert pg.commits == 0
    assert pg.rollbacks == 1


def test_script_help_smoke():
    result = subprocess.run(
        [sys.executable, str(SCRIPT), "--help"],
        cwd=REPO_ROOT,
        capture_output=True,
        text=True,
    )
    assert result.returncode == 0, result.stderr
    assert "--workspace-id" in result.stdout
    assert "--apply" in result.stdout
    assert "Dry-run is the default" in result.stdout


def test_cli_rejects_a_different_target_before_connecting(monkeypatch):
    monkeypatch.setenv("DEMO_WORKSPACE_ID", "ws-demo")
    monkeypatch.delenv("DATABASE_URL", raising=False)
    result = subprocess.run(
        [sys.executable, str(SCRIPT), "--workspace-id", "ws-own", "--apply"],
        cwd=REPO_ROOT,
        capture_output=True,
        text=True,
    )
    assert result.returncode == 2
    assert "must match the configured DEMO_WORKSPACE_ID" in result.stderr


@pytest.mark.parametrize("apply", [False, True])
def test_main_reports_the_result_and_closes_the_connection(pg, monkeypatch, capsys, apply):
    args = [str(SCRIPT), "--workspace-id", "ws-demo"]
    if apply:
        args.append("--apply")
    monkeypatch.setattr(sys, "argv", args)
    monkeypatch.setattr(command, "postgres_connection", lambda: pg)
    command.main()
    assert pg.closed
    if apply:
        assert "removed 2 demo VIEWER memberships" in capsys.readouterr().out
    else:
        assert "dry run: 2 demo VIEWER memberships would be removed" in capsys.readouterr().out


def test_main_closes_the_connection_after_a_failed_reset(pg, monkeypatch):
    monkeypatch.setattr(sys, "argv", [str(SCRIPT), "--workspace-id", "ws-demo", "--apply"])
    monkeypatch.setattr(command, "postgres_connection", lambda: pg)
    pg.fail_commit = True
    with pytest.raises(RuntimeError, match="commit failed"):
        command.main()
    assert pg.closed


def test_main_rejects_a_different_workspace_before_connecting(monkeypatch):
    monkeypatch.setenv("DEMO_WORKSPACE_ID", "ws-demo")
    monkeypatch.setattr(sys, "argv", [str(SCRIPT), "--workspace-id", "ws-own", "--apply"])
    monkeypatch.setattr(
        command, "postgres_connection", lambda: pytest.fail("must not connect to the database")
    )
    with pytest.raises(SystemExit) as error:
        command.main()
    assert error.value.code == 2
