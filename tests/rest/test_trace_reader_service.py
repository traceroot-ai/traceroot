from types import SimpleNamespace

from rest.services.trace_reader import TraceReaderService


class RecordingClient:
    def __init__(self, handlers):
        self.handlers = handlers
        self.calls = []

    def query(self, query, parameters=None):
        self.calls.append((query, parameters))
        return self.handlers[len(self.calls) - 1](query, parameters or {})


def _rows(rows):
    return SimpleNamespace(result_rows=rows)


def test_list_sessions_backfills_input_output_with_conditional_aggregates():
    service = TraceReaderService.__new__(TraceReaderService)

    def main_query(query, _params):
        assert "FROM (" in query
        return _rows(
            [["sess-1", 1, ["user-1"], "2026-04-30", "2026-04-30", 10, 1, 2, 0.1, "", "{}"]]
        )

    def count_query(_query, _params):
        return _rows([[1]])

    def span_query(query, params):
        assert "argMinIf(s.input, s.span_start_time, s.input != '' AND s.input != '{}')" in query
        assert "argMaxIf(s.output, s.span_end_time, s.output != '' AND s.output != '{}')" in query
        assert params["session_ids"] == ["sess-1"]
        return _rows([["sess-1", "real input", "real output"]])

    service._client = RecordingClient([main_query, count_query, span_query])

    result = service.list_sessions("proj-1")

    assert result["data"][0]["input"] == "real input"
    assert result["data"][0]["output"] == "real output"


def test_get_session_backfills_trace_io_with_conditional_aggregates():
    service = TraceReaderService.__new__(TraceReaderService)

    def traces_query(query, _params):
        assert "ORDER BY t.trace_start_time ASC" in query
        return _rows([["trace-1", "Trace 1", "2026-04-30", "user-1", "", "{}", 12, "ok"]])

    def span_query(query, params):
        assert "argMinIf(input, span_start_time, input != '' AND input != '{}')" in query
        assert "argMaxIf(output, span_end_time, output != '' AND output != '{}')" in query
        assert params["trace_ids"] == ["trace-1"]
        return _rows([["trace-1", "span input", "span output"]])

    def tokens_query(_query, _params):
        return _rows([[3, 4, 0.25]])

    service._client = RecordingClient([traces_query, span_query, tokens_query])

    result = service.get_session("proj-1", "sess-1")

    assert result is not None
    assert result["traces"][0]["input"] == "span input"
    assert result["traces"][0]["output"] == "span output"
