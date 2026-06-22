"""Regression guard for deterministic sibling span ordering (issue #1161).

span_start_time is stored at millisecond precision, so sub-ms parallel siblings
tie. The span query must carry span_end_time + span_id tie-breakers so two reads
of the same trace return identical order. The ClickHouse client is stubbed, so
this asserts the ORDER BY clause directly rather than exercising a live DB.
"""

from rest.services.trace_reader import TraceReaderService


class _StubResult:
    def __init__(self, rows):
        self.result_rows = rows


class _StubClient:
    def __init__(self):
        self.calls = []

    def query(self, query, parameters=None):
        self.calls.append((query, parameters))
        normalized = " ".join(query.split())
        if "FROM traces FINAL" in normalized:
            return _StubResult(
                [
                    [
                        "trace-1",
                        "project-1",
                        "Trace Name",
                        "2024-01-01T00:00:00.000Z",
                        "user-1",
                        "session-1",
                        "main",
                        "repo",
                        None,
                        None,
                        None,
                    ]
                ]
            )
        if "FROM spans FINAL" in normalized:
            return _StubResult([])
        raise AssertionError(f"Unexpected query: {query}")


def test_get_trace_uses_stable_span_ordering(monkeypatch):
    stub = _StubClient()
    monkeypatch.setattr("rest.services.trace_reader.get_clickhouse_client", lambda: stub)

    service = TraceReaderService()
    trace = service.get_trace("project-1", "trace-1")

    assert trace is not None
    span_query = next(query for query, _ in stub.calls if "FROM spans FINAL" in query)
    assert "ORDER BY span_start_time ASC, span_end_time ASC, span_id ASC" in span_query
