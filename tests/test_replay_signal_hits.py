"""Unit tests for scripts/replay_signal_hits.py: list a project's given-up
signal hits, and with --apply delete their give-up rows and mark their
detectors pending so the worker assigns them again."""

import subprocess
import sys
import sysconfig
from datetime import UTC, datetime
from pathlib import Path
from unittest.mock import MagicMock

REPO_ROOT = Path(__file__).resolve().parent.parent
SCRIPT = REPO_ROOT / "scripts" / "replay_signal_hits.py"

from scripts.replay_signal_hits import LOOKBACK, replay  # noqa: E402

NOW = datetime(2026, 10, 5, 12, 0, tzinfo=UTC)


def fake_ch(rows):
    ch = MagicMock()
    ch.query.return_value = MagicMock(result_rows=rows)
    return ch


def fake_pg():
    pg = MagicMock()
    cursor = MagicMock()
    pg.cursor.return_value.__enter__.return_value = cursor
    return pg, cursor


def test_runs_without_pythonpath_set():
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


def test_dry_run_lists_hits_within_the_lookback_and_changes_nothing():
    ch = fake_ch([("det-a", "run-1"), ("det-b", "run-2")])
    pg, cursor = fake_pg()

    hits = replay(pg, ch, "proj", now=NOW)

    assert hits == [("det-a", "run-1"), ("det-b", "run-2")]
    params = ch.query.call_args.kwargs["parameters"]
    assert params == {"project_id": "proj", "detector_id": "", "since": NOW - LOOKBACK}
    # Only give-up rows, never a hit placed in a signal.
    assert "signal_id = ''" in ch.query.call_args.args[0]
    ch.delete_given_up_signal_assignments.assert_not_called()
    cursor.execute.assert_not_called()


def test_apply_deletes_the_give_up_rows_and_marks_each_detector_pending_once():
    ch = fake_ch([("det-a", "run-1"), ("det-a", "run-3"), ("det-b", "run-2")])
    pg, cursor = fake_pg()
    order = []
    pg.commit.side_effect = lambda: order.append("mark")
    ch.delete_given_up_signal_assignments.side_effect = lambda *_: order.append("delete")

    replay(pg, ch, "proj", apply=True, now=NOW)

    # Marked first, so a failed delete leaves rows a rerun can still find, and
    # again after, in case a round cleared the mark while the delete ran.
    assert order == ["mark", "delete", "mark"]
    ch.delete_given_up_signal_assignments.assert_called_once_with(
        "proj", ["run-1", "run-3", "run-2"]
    )
    sql, params = cursor.execute.call_args.args
    assert "assignment_pending_at" in sql
    assert params == (NOW.replace(tzinfo=None), "proj", ["det-a", "det-b"])
    assert pg.commit.call_count == 2


def test_apply_with_nothing_given_up_touches_nothing():
    ch = fake_ch([])
    pg, cursor = fake_pg()

    assert replay(pg, ch, "proj", "det-a", apply=True, now=NOW) == []
    assert ch.query.call_args.kwargs["parameters"]["detector_id"] == "det-a"
    ch.delete_given_up_signal_assignments.assert_not_called()
    cursor.execute.assert_not_called()


def test_clickhouse_delete_touches_only_give_up_rows():
    from db.clickhouse.client import ClickHouseClient

    raw = MagicMock()
    ClickHouseClient(raw).delete_given_up_signal_assignments("proj", ["run-1"])
    sql = raw.command.call_args.args[0]
    assert "DELETE FROM signal_assignments" in sql and "signal_id = ''" in sql
    assert raw.command.call_args.kwargs["parameters"] == {
        "project_id": "proj",
        "run_ids": ["run-1"],
    }
    # Returns only once the rows are gone.
    assert raw.command.call_args.kwargs["settings"] == {"lightweight_deletes_sync": 2}
    raw.reset_mock()
    ClickHouseClient(raw).delete_given_up_signal_assignments("proj", [])
    raw.command.assert_not_called()
