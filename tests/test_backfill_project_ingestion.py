"""Backfill defaults to a dry run and uses retained span receive times."""

from datetime import UTC, datetime
from unittest.mock import MagicMock

import pytest

from scripts.backfill_project_ingestion import backfill


@pytest.fixture()
def sinks(monkeypatch):
    pg, ch, record = MagicMock(), MagicMock(), MagicMock()
    cursor = pg.getconn.return_value.cursor.return_value.__enter__.return_value
    cursor.fetchall.return_value = [("p1",), ("p2",)]
    ch.query.return_value.result_rows = [("p1", datetime(2026, 11, 13, 12, tzinfo=UTC))]
    monkeypatch.setattr("scripts.backfill_project_ingestion.get_pg_pool", lambda: pg)
    monkeypatch.setattr("scripts.backfill_project_ingestion.get_clickhouse_client", lambda: ch)
    monkeypatch.setattr("scripts.backfill_project_ingestion.record_project_ingestion", record)
    return pg, ch, record


def test_dry_run_does_not_write(sinks):
    pg, ch, record = sinks
    assert backfill() == 1
    record.assert_not_called()
    assert ch.query.call_args.kwargs["parameters"] == {"ids": ["p1", "p2"]}
    pg.putconn.assert_called_once()


def test_apply_passes_the_recovered_timestamp_to_the_monotonic_writer(sinks):
    _, _, record = sinks
    assert backfill(apply=True) == 1
    record.assert_called_once_with({"p1"}, datetime(2026, 11, 13, 12, tzinfo=UTC))


def test_no_retained_spans_leaves_dates_unknown(sinks):
    _, ch, record = sinks
    ch.query.return_value.result_rows = []
    assert backfill(apply=True) == 0
    record.assert_not_called()


def test_no_projects_requires_no_telemetry_query(sinks):
    pg, ch, record = sinks
    pg.getconn.return_value.cursor.return_value.__enter__.return_value.fetchall.return_value = []
    assert backfill() == 0
    ch.query.assert_not_called()
    record.assert_not_called()


def test_failed_project_read_returns_the_connection(sinks):
    pg, _, record = sinks
    cursor = pg.getconn.return_value.cursor.return_value.__enter__.return_value
    cursor.execute.side_effect = RuntimeError("database unavailable")
    with pytest.raises(RuntimeError, match="database unavailable"):
        backfill()
    pg.putconn.assert_called_once_with(pg.getconn.return_value, close=True)
    record.assert_not_called()
