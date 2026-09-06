"""Source scoping in TraceReaderService: get_trace's filter, and the detector
exclusion on every customer-facing read that scans spans or traces."""

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
        assert "source = 'user'" in trace_sql
        assert "source = 'user'" in spans_sql

    def test_no_source_defaults_to_customer_traffic(self):
        # Fail-closed: a caller that omits `source` must not be handed internal
        # telemetry. A self-trace's id is the dashless run id the runs surface shows
        # the customer, so an unscoped by-id read would be directly reachable from
        # the public trace endpoint and its export.
        trace_sql, spans_sql = self._sqls(None)
        for sql in (trace_sql, spans_sql):
            assert "source = 'user'" in sql
            assert "source = 'detector'" not in sql


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
        assert "t.source = 'user'" in data_sql
        assert "t.source = 'user'" in count_sql


class TestCustomerTrafficOnlyHelper:
    def test_qualifies_the_column_with_the_alias(self):
        from rest.services.trace_reader import customer_traffic_only

        assert customer_traffic_only("t") == "t.source = 'user'"

    def test_omits_the_prefix_when_unaliased(self):
        from rest.services.trace_reader import customer_traffic_only

        assert customer_traffic_only() == "source = 'user'"


class TestDistinctSpanValuesExcludesDetector:
    """Discovery lives in its own service now, but it reuses this module's shared
    predicate, so the exclusion is asserted here alongside every other customer-facing
    read rather than only where discovery's own tests live."""

    def _discovery_with_mock_client(self):
        with patch("rest.services.trace_discovery.get_clickhouse_client") as get_client:
            client = MagicMock()
            get_client.return_value = client
            from rest.services.trace_discovery import TraceDiscoveryService

            service = TraceDiscoveryService()
        return service, client

    def test_dropdown_options_skip_detector_spans(self):
        service, client = self._discovery_with_mock_client()
        result = MagicMock()
        result.result_rows = []
        client.query.return_value = result

        service.get_distinct_span_values("p-1", "model_name")

        sql = client.query.call_args_list[0].args[0]
        assert "source = 'user'" in sql


class TestListSessionsExcludesDetector:
    def test_data_and_count_queries_exclude_detector(self):
        service, client = _service_with_mock_client()
        data_result = MagicMock()
        data_result.result_rows = []
        count_result = MagicMock()
        count_result.result_rows = [(0,)]
        client.query.side_effect = [data_result, count_result]

        service.list_sessions("p-1")

        for call in client.query.call_args_list[:2]:
            assert "t.source = 'user'" in call.args[0]

    def test_io_backfill_query_excludes_detector(self):
        # The backfill re-resolves traces by session_id rather than by the already
        # filtered trace ids, so it needs the predicate in its own right.
        service, client = _service_with_mock_client()
        data_result = MagicMock()
        # Empty trace-level input/output is what triggers the span I/O backfill.
        data_result.result_rows = [("s-1", 1, [""], None, None, None, None, None, None, "", "")]
        count_result = MagicMock()
        count_result.result_rows = [(1,)]
        backfill_result = MagicMock()
        backfill_result.result_rows = []
        client.query.side_effect = [data_result, count_result, backfill_result]

        service.list_sessions("p-1")

        assert len(client.query.call_args_list) == 3, "backfill query did not run"
        assert "t.source = 'user'" in client.query.call_args_list[2].args[0]


class TestGetSessionExcludesDetector:
    def test_traces_query_excludes_detector(self):
        service, client = _service_with_mock_client()
        traces_result = MagicMock()
        traces_result.result_rows = []
        client.query.return_value = traces_result

        assert service.get_session("p-1", "s-1") is None

        assert "t.source = 'user'" in client.query.call_args_list[0].args[0]


class TestListUsersExcludesDetector:
    def test_data_and_count_queries_exclude_detector(self):
        service, client = _service_with_mock_client()
        data_result = MagicMock()
        data_result.result_rows = []
        count_result = MagicMock()
        count_result.result_rows = [(0,)]
        client.query.side_effect = [data_result, count_result]

        service.list_users("p-1")

        for call in client.query.call_args_list[:2]:
            assert "t.source = 'user'" in call.args[0]
