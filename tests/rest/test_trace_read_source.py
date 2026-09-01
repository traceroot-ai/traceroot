"""get_trace's source scope: 'agent' is opt-in like 'detector'; the default stays customer-only."""

from unittest.mock import MagicMock

import pytest

from rest.services.trace_reader import AGENT_SOURCE, DETECTOR_SOURCE, TraceReaderService


@pytest.fixture()
def reader():
    ch = MagicMock()
    # A non-empty trace row is required for get_trace to go on and build the
    # spans query. With empty rows it returns None after the first query, and
    # every assertion below would silently cover only half the read — the spans
    # query carries the same source predicate and must be checked too.
    ch.query.side_effect = [
        MagicMock(
            result_rows=[("t1", "p1", "root") + (None,) * 8]
        ),  # 11 cols: get_trace unpacks row[0..10]
        MagicMock(result_rows=[]),
    ]
    svc = TraceReaderService.__new__(TraceReaderService)
    svc._client = ch  # unit test wires the client directly
    return svc, ch


def _sqls(ch: MagicMock) -> list[str]:
    """Every query get_trace issued — the trace read and the spans read."""
    return [call.args[0] for call in ch.query.call_args_list]


def _trace_sql(ch: MagicMock) -> str:
    return ch.query.call_args_list[0].args[0]


def _assert_scoped(ch: MagicMock, predicate: str) -> None:
    """The predicate must appear in every query the read issued, not just the first."""
    sqls = _sqls(ch)
    assert len(sqls) >= 2, f"expected a trace query and a spans query, got {len(sqls)}"
    for i, sql in enumerate(sqls):
        assert predicate in sql, f"query {i} is not scoped by {predicate!r}"


def test_agent_source_reads_agent_rows_only(reader):
    svc, ch = reader
    svc.get_trace("p1", "t1", source=AGENT_SOURCE)
    _assert_scoped(ch, "source = 'agent'")
    assert all("source = 'user'" not in sql for sql in _sqls(ch))


def test_detector_source_unchanged(reader):
    svc, ch = reader
    svc.get_trace("p1", "t1", source=DETECTOR_SOURCE)
    _assert_scoped(ch, "source = 'detector'")


def test_default_is_customer_traffic_only(reader):
    svc, ch = reader
    svc.get_trace("p1", "t1")
    _assert_scoped(ch, "source = 'user'")


def test_unknown_source_falls_back_to_customer_traffic(reader):
    svc, ch = reader
    svc.get_trace("p1", "t1", source="anything-else")
    _assert_scoped(ch, "source = 'user'")
