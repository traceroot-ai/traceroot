"""get_trace's source scope: 'agent' is opt-in like 'detector'; the default stays customer-only."""

from unittest.mock import MagicMock

import pytest

from rest.services.trace_reader import AGENT_SOURCE, DETECTOR_SOURCE, TraceReaderService


@pytest.fixture()
def reader():
    ch = MagicMock()
    ch.query.return_value = MagicMock(result_rows=[])
    svc = TraceReaderService.__new__(TraceReaderService)
    svc._client = ch  # unit test wires the client directly
    return svc, ch


def _trace_sql(ch: MagicMock) -> str:
    return ch.query.call_args_list[0].args[0]


def test_agent_source_reads_agent_rows_only(reader):
    svc, ch = reader
    svc.get_trace("p1", "t1", source=AGENT_SOURCE)
    assert "source = 'agent'" in _trace_sql(ch)
    assert "source = 'user'" not in _trace_sql(ch)


def test_detector_source_unchanged(reader):
    svc, ch = reader
    svc.get_trace("p1", "t1", source=DETECTOR_SOURCE)
    assert "source = 'detector'" in _trace_sql(ch)


def test_default_is_customer_traffic_only(reader):
    svc, ch = reader
    svc.get_trace("p1", "t1")
    assert "source = 'user'" in _trace_sql(ch)


def test_unknown_source_falls_back_to_customer_traffic(reader):
    svc, ch = reader
    svc.get_trace("p1", "t1", source="anything-else")
    assert "source = 'user'" in _trace_sql(ch)
