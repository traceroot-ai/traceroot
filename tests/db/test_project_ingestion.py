"""Transaction behavior for persisted project ingestion times."""

from datetime import UTC, datetime, timedelta, timezone
from unittest.mock import MagicMock

import pytest

from db.project_ingestion import record_project_ingestion

RECEIVED = datetime(2026, 11, 13, 12, 34, 56, tzinfo=UTC)


@pytest.fixture()
def pool(monkeypatch):
    pool = MagicMock()
    monkeypatch.setattr("db.project_ingestion.get_pg_pool", lambda: pool)
    return pool


def test_empty_batch_never_borrows_a_connection(pool):
    record_project_ingestion(set(), RECEIVED)
    pool.getconn.assert_not_called()


def test_commits_receive_time_for_the_named_projects(pool):
    record_project_ingestion({"p2", "p1"}, RECEIVED)
    conn = pool.getconn.return_value
    _, params = conn.cursor.return_value.__enter__.return_value.execute.call_args.args
    assert params == (RECEIVED.replace(tzinfo=None), ["p1", "p2"], RECEIVED.replace(tzinfo=None))
    conn.commit.assert_called_once()
    pool.putconn.assert_called_once_with(conn, close=False)


@pytest.mark.parametrize(
    "received",
    [
        datetime(2026, 11, 13, 12, 34, 56),
        datetime(2026, 11, 13, 17, 34, 56, tzinfo=timezone(timedelta(hours=5))),
    ],
)
def test_dates_are_normalized_to_utc_for_timestamp_storage(pool, received):
    record_project_ingestion({"p1"}, received)
    cursor = pool.getconn.return_value.cursor.return_value.__enter__.return_value
    assert cursor.execute.call_args.args[1][0] == datetime(2026, 11, 13, 12, 34, 56)


@pytest.mark.parametrize("operation", ["execute", "commit"])
@pytest.mark.parametrize("rollback_fails", [False, True])
def test_failures_propagate_and_evict_the_connection(pool, operation, rollback_fails):
    conn = pool.getconn.return_value
    cursor = conn.cursor.return_value.__enter__.return_value
    target = cursor.execute if operation == "execute" else conn.commit
    target.side_effect = RuntimeError("database unavailable")
    if rollback_fails:
        conn.rollback.side_effect = RuntimeError("connection closed")
    with pytest.raises(RuntimeError, match="database unavailable"):
        record_project_ingestion({"p1"}, RECEIVED)
    conn.rollback.assert_called_once()
    pool.putconn.assert_called_once_with(conn, close=True)


def test_pool_failure_propagates_without_acknowledging_activity(pool):
    pool.getconn.side_effect = RuntimeError("pool unavailable")
    with pytest.raises(RuntimeError, match="pool unavailable"):
        record_project_ingestion({"p1"}, RECEIVED)
    pool.putconn.assert_not_called()
