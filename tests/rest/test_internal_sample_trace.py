from rest.routers.internal import create_sample_trace


class FakeClickHouse:
    def __init__(self):
        self.traces = []
        self.spans = []

    def insert_traces_batch(self, traces):
        self.traces.extend(traces)

    def insert_spans_batch(self, spans):
        self.spans.extend(spans)


async def test_create_sample_trace_inserts_realistic_trace(monkeypatch):
    fake = FakeClickHouse()
    monkeypatch.setattr("rest.routers.internal.get_clickhouse_client", lambda: fake)

    response = await create_sample_trace("proj-1")

    assert response.span_count == 4
    assert len(response.trace_id) == 32
    assert fake.traces[0]["project_id"] == "proj-1"
    assert fake.traces[0]["name"] == "Sample support agent run"
    assert {span["span_kind"] for span in fake.spans} == {"AGENT", "TOOL", "LLM"}
    assert fake.spans[0]["parent_span_id"] is None
    assert all(span["trace_id"] == response.trace_id for span in fake.spans)
