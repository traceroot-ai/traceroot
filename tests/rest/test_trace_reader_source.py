"""Source scoping in TraceReaderService: get_trace filter + list_traces exclusion."""

from unittest.mock import MagicMock, patch

TRACE_ROW = (
    "t-1",
    "p-1",
    "root",
    None,  # trace_start_time — None skips the span time-bound branch
    None,
    None,
    None,
    None,
    None,
    None,
    None,
)


def _service_with_mock_client():
    with patch("rest.services.trace_reader.get_clickhouse_client") as get_client:
        client = MagicMock()
        get_client.return_value = client
        from rest.services.trace_reader import TraceReaderService

        service = TraceReaderService()
    return service, client


def _trace_and_span_results(client):
    trace_result = MagicMock()
    trace_result.result_rows = [TRACE_ROW]
    spans_result = MagicMock()
    spans_result.result_rows = []
    client.query.side_effect = [trace_result, spans_result]


class TestGetTraceSourceFilter:
    def _sqls(self, source):
        service, client = _service_with_mock_client()
        _trace_and_span_results(client)
        service.get_trace("p-1", "t-1", source=source)
        return (
            client.query.call_args_list[0].args[0],
            client.query.call_args_list[1].args[0],
        )

    def test_detector_source_restricts_both_queries(self):
        trace_sql, spans_sql = self._sqls("detector")
        assert "source = 'detector'" in trace_sql
        assert "source = 'detector'" in spans_sql

    def test_user_source_excludes_detector_in_both_queries(self):
        trace_sql, spans_sql = self._sqls("user")
        assert "source != 'detector'" in trace_sql
        assert "source != 'detector'" in spans_sql

    def test_no_source_leaves_queries_unfiltered(self):
        trace_sql, spans_sql = self._sqls(None)
        for sql in (trace_sql, spans_sql):
            assert "source = 'detector'" not in sql
            assert "source != 'detector'" not in sql


class TestListTracesExcludesDetector:
    def test_data_and_count_queries_exclude_detector(self):
        service, client = _service_with_mock_client()
        data_result = MagicMock()
        data_result.result_rows = []
        count_result = MagicMock()
        count_result.result_rows = [(0,)]
        client.query.side_effect = [data_result, count_result]

        service.list_traces("p-1")

        data_sql = client.query.call_args_list[0].args[0]
        count_sql = client.query.call_args_list[1].args[0]
        assert "t.source != 'detector'" in data_sql
        assert "t.source != 'detector'" in count_sql
