"""Tests for the streaming transform API (TransformContext + iter_transform_spans).

Verifies that the streaming generator produces identical output to the original
monolithic ``transform_otel_to_clickhouse``, and that TransformContext correctly
accumulates and finalizes trace-level metadata across spans.
"""

import json
import types
from collections.abc import Generator
from datetime import UTC, datetime
from unittest.mock import MagicMock

from tests.fixtures.otel_payloads import (
    make_attr,
    make_eval_trace,
    make_otel_payload,
    make_span,
)
from worker.ingest_tasks import _REDIS_CONTEXT, _flush_span_chunk, _publish_live_spans
from worker.otel_transform import (
    TransformContext,
    iter_transform_spans,
    transform_otel_to_clickhouse,
)

# ── Reusable IDs ────────────────────────────────────────────────────────

TRACE_A = "aa" * 16
TRACE_B = "bb" * 16
ROOT_SPAN = "11" * 8
CHILD_SPAN = "22" * 8
CHILD_SPAN_2 = "33" * 8
GRANDCHILD_SPAN = "44" * 8


# ── TransformContext ────────────────────────────────────────────────────


class TestTransformContext:
    """Unit tests for TransformContext initialization and finalize_traces."""

    def test_empty_context_finalize(self):
        """An empty context with no spans produces no traces."""
        ctx = TransformContext(project_id="proj-1")
        assert ctx.finalize_traces() == []

    def test_context_fields_initialized_empty(self):
        ctx = TransformContext(project_id="proj-1")
        assert ctx.traces == {}
        assert ctx.trace_attrs == {}
        assert ctx.root_bearing_trace_ids == set()
        assert ctx._trace_is_evaluation == set()
        assert ctx._trace_environment == {}

    def test_finalize_name_correction(self):
        """finalize_traces applies the shortest-depth name candidate."""
        ctx = TransformContext(project_id="proj-1")
        ctx.traces[TRACE_A] = {"trace_id": TRACE_A, "name": "deep-child"}
        # depth=0 means root — should win over any other candidate
        ctx._trace_name_candidates[TRACE_A] = (0, "root-span-name")
        traces = ctx.finalize_traces()
        assert traces[0]["name"] == "root-span-name"

    def test_finalize_evaluation_classification(self):
        """finalize_traces marks traces with evaluation spans."""
        ctx = TransformContext(project_id="proj-1")
        ctx.traces[TRACE_A] = {"trace_id": TRACE_A, "name": "test"}
        ctx._trace_is_evaluation.add(TRACE_A)
        traces = ctx.finalize_traces()
        assert traces[0]["is_evaluation"] is True

    def test_finalize_evaluation_only_flagged_traces(self):
        """Traces without evaluation spans are not marked."""
        ctx = TransformContext(project_id="proj-1")
        ctx.traces[TRACE_A] = {"trace_id": TRACE_A, "name": "test"}
        ctx.traces[TRACE_B] = {"trace_id": TRACE_B, "name": "test2"}
        ctx._trace_is_evaluation.add(TRACE_A)
        traces = ctx.finalize_traces()
        a_trace = next(t for t in traces if t["trace_id"] == TRACE_A)
        b_trace = next(t for t in traces if t["trace_id"] == TRACE_B)
        assert a_trace.get("is_evaluation") is True
        assert "is_evaluation" not in b_trace

    def test_finalize_environment_promotion(self):
        """Environment from a child span is promoted when the trace has none."""
        ctx = TransformContext(project_id="proj-1")
        ctx.traces[TRACE_A] = {"trace_id": TRACE_A, "name": "test"}
        ctx._trace_environment[TRACE_A] = "production"
        traces = ctx.finalize_traces()
        assert traces[0]["environment"] == "production"

    def test_finalize_environment_no_overwrite(self):
        """Environment already set on the trace is not overwritten."""
        ctx = TransformContext(project_id="proj-1")
        ctx.traces[TRACE_A] = {"trace_id": TRACE_A, "name": "test", "environment": "staging"}
        ctx._trace_environment[TRACE_A] = "production"
        traces = ctx.finalize_traces()
        assert traces[0]["environment"] == "staging"

    def test_finalize_user_id_promotion(self):
        """user_id from child spans is promoted to trace."""
        ctx = TransformContext(project_id="proj-1")
        ctx.traces[TRACE_A] = {"trace_id": TRACE_A, "name": "test"}
        ctx.trace_attrs[TRACE_A] = {"user_id": "user-42", "session_id": "sess-7"}
        traces = ctx.finalize_traces()
        assert traces[0]["user_id"] == "user-42"
        assert traces[0]["session_id"] == "sess-7"

    def test_finalize_git_attrs_promotion(self):
        """git_ref and git_repo are promoted from child spans."""
        ctx = TransformContext(project_id="proj-1")
        ctx.traces[TRACE_A] = {"trace_id": TRACE_A, "name": "test"}
        ctx.trace_git_attrs[TRACE_A] = {"git_ref": "main", "git_repo": "org/repo"}
        traces = ctx.finalize_traces()
        assert traces[0]["git_ref"] == "main"
        assert traces[0]["git_repo"] == "org/repo"


# ── iter_transform_spans ────────────────────────────────────────────────


class TestIterTransformSpans:
    """Tests for the streaming generator."""

    def test_returns_generator(self):
        """iter_transform_spans returns a generator, not a list."""
        ctx = TransformContext(project_id="proj-1")
        payload = make_otel_payload([])
        result = iter_transform_spans(payload, "proj-1", ctx)
        assert isinstance(result, (Generator, types.GeneratorType))

    def test_empty_payload(self):
        """Empty resourceSpans yields nothing."""
        ctx = TransformContext(project_id="proj-1")
        spans = list(iter_transform_spans({"resourceSpans": []}, "proj-1", ctx))
        assert spans == []
        assert ctx.finalize_traces() == []

    def test_empty_dict_payload(self):
        """Missing resourceSpans key yields nothing."""
        ctx = TransformContext(project_id="proj-1")
        spans = list(iter_transform_spans({}, "proj-1", ctx))
        assert spans == []

    def test_single_root_span(self):
        """A single root span yields one span record and creates one trace."""
        payload = make_otel_payload([make_span(TRACE_A, ROOT_SPAN, name="my-trace")])
        ctx = TransformContext(project_id="proj-1")
        spans = list(iter_transform_spans(payload, "proj-1", ctx))

        assert len(spans) == 1
        assert spans[0]["span_id"] == ROOT_SPAN
        assert spans[0]["trace_id"] == TRACE_A
        assert spans[0]["parent_span_id"] is None
        assert spans[0]["project_id"] == "proj-1"

        traces = ctx.finalize_traces()
        assert len(traces) == 1
        assert traces[0]["trace_id"] == TRACE_A
        assert traces[0]["name"] == "my-trace"

    def test_root_bearing_trace_ids_tracked(self):
        """Root spans are tracked in ctx.root_bearing_trace_ids."""
        payload = make_otel_payload(
            [
                make_span(TRACE_A, ROOT_SPAN, name="root"),
                make_span(TRACE_A, CHILD_SPAN, name="child", parent_span_id_hex=ROOT_SPAN),
            ]
        )
        ctx = TransformContext(project_id="proj-1")
        list(iter_transform_spans(payload, "proj-1", ctx))
        assert TRACE_A in ctx.root_bearing_trace_ids

    def test_child_only_trace_not_root_bearing(self):
        """A trace with only child spans (no root) is not root-bearing."""
        payload = make_otel_payload(
            [
                make_span(TRACE_A, CHILD_SPAN, name="child", parent_span_id_hex=ROOT_SPAN),
            ]
        )
        ctx = TransformContext(project_id="proj-1")
        list(iter_transform_spans(payload, "proj-1", ctx))
        assert TRACE_A not in ctx.root_bearing_trace_ids

    def test_parent_child_spans(self):
        """Both parent and child spans are yielded and trace is resolved."""
        payload = make_otel_payload(
            [
                make_span(TRACE_A, ROOT_SPAN, name="root"),
                make_span(TRACE_A, CHILD_SPAN, name="child", parent_span_id_hex=ROOT_SPAN),
            ]
        )
        ctx = TransformContext(project_id="proj-1")
        spans = list(iter_transform_spans(payload, "proj-1", ctx))

        assert len(spans) == 2
        span_ids = {s["span_id"] for s in spans}
        assert ROOT_SPAN in span_ids
        assert CHILD_SPAN in span_ids

        # Root span's name wins for the trace
        traces = ctx.finalize_traces()
        assert traces[0]["name"] == "root"

    def test_span_kind_explicit_llm(self):
        """Explicit traceroot.span.type=LLM is preserved."""
        payload = make_otel_payload(
            [
                make_span(
                    TRACE_A,
                    ROOT_SPAN,
                    attributes=[
                        make_attr("traceroot.span.type", "LLM"),
                    ],
                ),
            ]
        )
        ctx = TransformContext(project_id="proj-1")
        spans = list(iter_transform_spans(payload, "proj-1", ctx))
        assert spans[0]["span_kind"] == "LLM"

    def test_span_kind_openinference_tool(self):
        """OpenInference TOOL kind is recognized."""
        payload = make_otel_payload(
            [
                make_span(
                    TRACE_A,
                    ROOT_SPAN,
                    attributes=[
                        make_attr("openinference.span.kind", "TOOL"),
                    ],
                ),
            ]
        )
        ctx = TransformContext(project_id="proj-1")
        spans = list(iter_transform_spans(payload, "proj-1", ctx))
        assert spans[0]["span_kind"] == "TOOL"

    def test_span_kind_default_is_span(self):
        """No kind attributes defaults to SPAN."""
        payload = make_otel_payload([make_span(TRACE_A, ROOT_SPAN)])
        ctx = TransformContext(project_id="proj-1")
        spans = list(iter_transform_spans(payload, "proj-1", ctx))
        assert spans[0]["span_kind"] == "SPAN"

    def test_input_output_extraction(self):
        """span input/output from traceroot attributes."""
        payload = make_otel_payload(
            [
                make_span(
                    TRACE_A,
                    ROOT_SPAN,
                    attributes=[
                        make_attr("traceroot.span.input", "hello world"),
                        make_attr("traceroot.span.output", "goodbye world"),
                    ],
                ),
            ]
        )
        ctx = TransformContext(project_id="proj-1")
        spans = list(iter_transform_spans(payload, "proj-1", ctx))
        assert spans[0]["input"] == "hello world"
        assert spans[0]["output"] == "goodbye world"

    def test_skips_spans_without_trace_id(self):
        """Spans with missing traceId are skipped."""
        payload = {
            "resourceSpans": [
                {
                    "resource": {"attributes": []},
                    "scopeSpans": [
                        {
                            "scope": {"name": "test"},
                            "spans": [
                                {
                                    "spanId": "AQAAAAAAAAAA",  # valid base64
                                    "name": "orphan",
                                    "startTimeUnixNano": "1705320000000000000",
                                    "endTimeUnixNano": "1705320001000000000",
                                    "attributes": [],
                                    "status": {"code": 0},
                                }
                            ],
                        }
                    ],
                }
            ],
        }
        ctx = TransformContext(project_id="proj-1")
        spans = list(iter_transform_spans(payload, "proj-1", ctx))
        assert spans == []

    def test_multiple_traces(self):
        """Spans from different traces yield correctly and create separate trace records."""
        payload = make_otel_payload(
            [
                make_span(TRACE_A, ROOT_SPAN, name="trace-a"),
                make_span(TRACE_B, CHILD_SPAN, name="trace-b"),
            ]
        )
        ctx = TransformContext(project_id="proj-1")
        spans = list(iter_transform_spans(payload, "proj-1", ctx))
        assert len(spans) == 2

        traces = ctx.finalize_traces()
        assert len(traces) == 2
        trace_names = {t["name"] for t in traces}
        assert trace_names == {"trace-a", "trace-b"}

    def test_evaluation_trace(self):
        """Evaluation spans mark the trace as is_evaluation."""
        payload = make_eval_trace(TRACE_A)
        ctx = TransformContext(project_id="proj-1")
        spans = list(iter_transform_spans(payload, "proj-1", ctx))

        # Should have 3 spans: root (evaluation), task, scorer
        assert len(spans) == 3

        traces = ctx.finalize_traces()
        assert len(traces) == 1
        assert traces[0]["is_evaluation"] is True

    def test_environment_from_span(self):
        """Environment attribute on spans propagates to trace."""
        payload = make_otel_payload(
            [
                make_span(
                    TRACE_A,
                    ROOT_SPAN,
                    attributes=[
                        make_attr("traceroot.environment", "production"),
                    ],
                ),
            ]
        )
        ctx = TransformContext(project_id="proj-1")
        list(iter_transform_spans(payload, "proj-1", ctx))
        traces = ctx.finalize_traces()
        assert traces[0].get("environment") == "production"

    def test_user_id_session_id_from_root(self):
        """user_id and session_id from root span land on the trace."""
        payload = make_otel_payload(
            [
                make_span(
                    TRACE_A,
                    ROOT_SPAN,
                    attributes=[
                        make_attr("traceroot.trace.user_id", "alice"),
                        make_attr("traceroot.trace.session_id", "sess-1"),
                    ],
                ),
            ]
        )
        ctx = TransformContext(project_id="proj-1")
        list(iter_transform_spans(payload, "proj-1", ctx))
        traces = ctx.finalize_traces()
        assert traces[0]["user_id"] == "alice"
        assert traces[0]["session_id"] == "sess-1"

    def test_user_id_from_child_when_root_missing(self):
        """Child span's user_id fills in when root has none."""
        payload = make_otel_payload(
            [
                make_span(
                    TRACE_A,
                    CHILD_SPAN,
                    parent_span_id_hex=ROOT_SPAN,
                    attributes=[
                        make_attr("traceroot.trace.user_id", "bob"),
                    ],
                ),
            ]
        )
        ctx = TransformContext(project_id="proj-1")
        list(iter_transform_spans(payload, "proj-1", ctx))
        traces = ctx.finalize_traces()
        assert traces[0].get("user_id") == "bob"


# ── Backward Compatibility ──────────────────────────────────────────────


class TestStreamingBackwardCompatibility:
    """The wrapper ``transform_otel_to_clickhouse`` must produce identical output
    to what the streaming pipeline produces when consumed in full."""

    @staticmethod
    def _streaming_result(payload, project_id="proj-1"):
        """Run the streaming path and return (traces, spans)."""
        ctx = TransformContext(project_id=project_id)
        spans = list(iter_transform_spans(payload, project_id, ctx))
        traces = ctx.finalize_traces()
        return traces, spans

    def test_single_root_span_matches(self):
        payload = make_otel_payload([make_span(TRACE_A, ROOT_SPAN, name="my-trace")])
        wrapper_traces, wrapper_spans = transform_otel_to_clickhouse(payload, "proj-1")
        stream_traces, stream_spans = self._streaming_result(payload)

        assert len(wrapper_spans) == len(stream_spans)
        assert len(wrapper_traces) == len(stream_traces)
        # Compare span fields
        for ws, ss in zip(wrapper_spans, stream_spans):
            assert ws["span_id"] == ss["span_id"]
            assert ws["trace_id"] == ss["trace_id"]
            assert ws["span_kind"] == ss["span_kind"]
        # Compare trace fields
        for wt, st in zip(wrapper_traces, stream_traces):
            assert wt["trace_id"] == st["trace_id"]
            assert wt["name"] == st["name"]

    def test_multi_span_trace_matches(self):
        """Parent + child + grandchild: counts and IDs match."""
        payload = make_otel_payload(
            [
                make_span(TRACE_A, ROOT_SPAN, name="root"),
                make_span(TRACE_A, CHILD_SPAN, name="child", parent_span_id_hex=ROOT_SPAN),
                make_span(
                    TRACE_A,
                    GRANDCHILD_SPAN,
                    name="grandchild",
                    parent_span_id_hex=CHILD_SPAN,
                ),
            ]
        )
        wrapper_traces, wrapper_spans = transform_otel_to_clickhouse(payload, "proj-1")
        stream_traces, stream_spans = self._streaming_result(payload)

        assert len(wrapper_spans) == len(stream_spans) == 3
        assert len(wrapper_traces) == len(stream_traces) == 1
        assert {s["span_id"] for s in wrapper_spans} == {s["span_id"] for s in stream_spans}

    def test_eval_trace_matches(self):
        """Evaluation traces produce identical output."""
        payload = make_eval_trace(TRACE_A)
        wrapper_traces, wrapper_spans = transform_otel_to_clickhouse(payload, "proj-1")
        stream_traces, stream_spans = self._streaming_result(payload)

        assert len(wrapper_spans) == len(stream_spans) == 3
        assert len(wrapper_traces) == len(stream_traces) == 1
        assert wrapper_traces[0].get("is_evaluation") == stream_traces[0].get("is_evaluation")

    def test_empty_payload_matches(self):
        """Empty payload produces empty results via both paths."""
        payload = {"resourceSpans": []}
        wrapper_traces, wrapper_spans = transform_otel_to_clickhouse(payload, "proj-1")
        stream_traces, stream_spans = self._streaming_result(payload)
        assert wrapper_traces == stream_traces == []
        assert wrapper_spans == stream_spans == []

    def test_all_span_fields_present(self):
        """Every field from the wrapper API is present in streaming output."""
        payload = make_otel_payload(
            [
                make_span(
                    TRACE_A,
                    ROOT_SPAN,
                    name="root",
                    attributes=[
                        make_attr("traceroot.span.type", "LLM"),
                        make_attr("traceroot.span.input", "hello"),
                        make_attr("traceroot.span.output", "world"),
                        make_attr("traceroot.environment", "prod"),
                        make_attr("gen_ai.request.model", "gpt-4"),
                    ],
                ),
            ]
        )
        _wrapper_traces, wrapper_spans = transform_otel_to_clickhouse(payload, "proj-1")
        _stream_traces, stream_spans = self._streaming_result(payload)

        # Every key in the wrapper span must also exist in the streaming span
        for key in wrapper_spans[0]:
            assert key in stream_spans[0], f"Missing key in streaming span: {key}"
            assert wrapper_spans[0][key] == stream_spans[0][key], (
                f"Mismatch for key {key}: wrapper={wrapper_spans[0][key]!r}, "
                f"stream={stream_spans[0][key]!r}"
            )


# ── Chunked Consumer Pattern ────────────────────────────────────────────


class FakeClickHouseClient:
    """Fake ClickHouse client recording batch inserts."""

    def __init__(self):
        self.inserted_batches = []

    def insert_spans_batch(self, spans: list[dict]):
        self.inserted_batches.append(list(spans))


class TestChunkedConsumer:
    """Tests for consuming iter_transform_spans in bounded-memory chunks via the flush path."""

    def _make_large_payload(self, n_spans: int) -> dict:
        """Build a payload with n_spans child spans under one root."""
        spans = [make_span(TRACE_A, ROOT_SPAN, name="root")]
        for i in range(n_spans - 1):
            span_id = f"{i + 2:016x}"
            spans.append(
                make_span(
                    TRACE_A,
                    span_id,
                    name=f"child-{i}",
                    parent_span_id_hex=ROOT_SPAN,
                )
            )
        return make_otel_payload(spans)

    def _setup_redis_context(self, mock_redis):
        """Set up thread-local Redis context as the production code does."""
        _REDIS_CONTEXT.client = mock_redis
        _REDIS_CONTEXT.defer_completions = True
        _REDIS_CONTEXT.completed_traces = set()

    def _teardown_redis_context(self):
        """Clean up thread-local Redis context."""
        _REDIS_CONTEXT.client = None
        _REDIS_CONTEXT.defer_completions = False
        _REDIS_CONTEXT.completed_traces = None

    def test_chunked_processes_all_spans(self):
        """All spans are processed and inserted via _flush_span_chunk."""
        payload = self._make_large_payload(50)
        ctx = TransformContext(project_id="proj-1")
        fake_ch = FakeClickHouseClient()
        mock_redis = MagicMock()
        self._setup_redis_context(mock_redis)

        try:
            chunk_size = 10
            chunk = []
            for span in iter_transform_spans(payload, "proj-1", ctx):
                chunk.append(span)
                if len(chunk) >= chunk_size:
                    _flush_span_chunk(
                        chunk,
                        fake_ch,
                        None,
                        "proj-1",
                        attachments_enabled=False,
                    )
                    chunk = []
            if chunk:
                _flush_span_chunk(
                    chunk,
                    fake_ch,
                    None,
                    "proj-1",
                    attachments_enabled=False,
                )
                chunk = []
        finally:
            self._teardown_redis_context()

        # 50 spans flushed in chunks of 10 = 5 ClickHouse insert calls of 10 spans each
        assert len(fake_ch.inserted_batches) == 5
        assert all(len(batch) == 10 for batch in fake_ch.inserted_batches)
        assert sum(len(batch) for batch in fake_ch.inserted_batches) == 50
        assert mock_redis.publish.called

    def test_chunk_sizes_bounded(self):
        """Each chunk flushed to ClickHouse is at most chunk_size spans."""
        payload = self._make_large_payload(27)
        ctx = TransformContext(project_id="proj-1")
        fake_ch = FakeClickHouseClient()
        mock_redis = MagicMock()
        self._setup_redis_context(mock_redis)

        try:
            chunk_size = 10
            chunk = []
            for span in iter_transform_spans(payload, "proj-1", ctx):
                chunk.append(span)
                if len(chunk) >= chunk_size:
                    _flush_span_chunk(
                        chunk,
                        fake_ch,
                        None,
                        "proj-1",
                        attachments_enabled=False,
                    )
                    chunk = []
            if chunk:
                _flush_span_chunk(
                    chunk,
                    fake_ch,
                    None,
                    "proj-1",
                    attachments_enabled=False,
                )
                chunk = []
        finally:
            self._teardown_redis_context()

        # 27 spans / 10 per chunk = batches of [10, 10, 7]
        batch_sizes = [len(batch) for batch in fake_ch.inserted_batches]
        assert batch_sizes == [10, 10, 7]

    def test_trace_finalization_after_exhaustion(self):
        """Traces are finalized correctly after all chunks are consumed."""
        payload = self._make_large_payload(20)
        ctx = TransformContext(project_id="proj-1")
        fake_ch = FakeClickHouseClient()
        mock_redis = MagicMock()
        self._setup_redis_context(mock_redis)

        try:
            chunk_size = 5
            chunk = []
            for span in iter_transform_spans(payload, "proj-1", ctx):
                chunk.append(span)
                if len(chunk) >= chunk_size:
                    _flush_span_chunk(
                        chunk,
                        fake_ch,
                        None,
                        "proj-1",
                        attachments_enabled=False,
                    )
                    chunk = []
            if chunk:
                _flush_span_chunk(
                    chunk,
                    fake_ch,
                    None,
                    "proj-1",
                    attachments_enabled=False,
                )
                chunk = []
        finally:
            self._teardown_redis_context()

        traces = ctx.finalize_traces()
        assert len(traces) == 1
        assert traces[0]["trace_id"] == TRACE_A
        assert traces[0]["name"] == "root"

    def test_root_bearing_ids_correct_after_chunked(self):
        """root_bearing_trace_ids is correct after chunked consumption."""
        payload = self._make_large_payload(15)
        ctx = TransformContext(project_id="proj-1")

        for _span in iter_transform_spans(payload, "proj-1", ctx):
            pass  # consume all

        assert ctx.root_bearing_trace_ids == {TRACE_A}

    def test_single_span_flush_path(self):
        """Flushing single-span chunks drives the real insert and publish path."""
        payload = self._make_large_payload(5)
        ctx = TransformContext(project_id="proj-1")
        fake_ch = FakeClickHouseClient()
        mock_redis = MagicMock()
        self._setup_redis_context(mock_redis)

        try:
            for span in iter_transform_spans(payload, "proj-1", ctx):
                _flush_span_chunk(
                    [span],
                    fake_ch,
                    None,
                    "proj-1",
                    attachments_enabled=False,
                )
        finally:
            self._teardown_redis_context()

        assert len(fake_ch.inserted_batches) == 5
        assert all(len(batch) == 1 for batch in fake_ch.inserted_batches)
        traces = ctx.finalize_traces()
        assert len(traces) == 1


# ── Live Span Publishing ────────────────────────────────────────────────


class TestLiveSpanPublishing:
    """Tests for live publishing connection reuse, field filtering, and completion deferral.

    The production code uses thread-local ``_REDIS_CONTEXT`` to pass the Redis
    client and defer_completions flag.  These tests exercise that path directly.
    """

    def test_publish_excludes_ch_update_time(self):
        """Published payloads must not contain the internal ch_update_time field."""
        mock_redis = MagicMock()
        _REDIS_CONTEXT.client = mock_redis
        _REDIS_CONTEXT.defer_completions = False
        _REDIS_CONTEXT.completed_traces = None

        try:
            span_with_ch_time = {
                "trace_id": TRACE_A,
                "span_id": ROOT_SPAN,
                "name": "my-span",
                "ch_update_time": datetime.now(UTC),
            }
            _publish_live_spans([span_with_ch_time], "proj-1")
        finally:
            _REDIS_CONTEXT.client = None

        assert mock_redis.publish.called
        channel, payload_str = mock_redis.publish.call_args_list[0][0]
        assert channel == f"trace:live:proj-1:{TRACE_A}"

        payload = json.loads(payload_str)
        assert payload["type"] == "spans"
        published_span = payload["spans"][0]
        assert "ch_update_time" not in published_span
        assert published_span["span_id"] == ROOT_SPAN

    def test_publish_defers_trace_complete_via_context(self):
        """When defer_completions is True, trace_complete is NOT published immediately.

        Instead the trace_id is recorded in completed_traces for the caller to
        signal after all chunks are flushed — matching the production path in
        process_s3_traces.
        """
        mock_redis = MagicMock()
        completed = set()

        # ── Deferred mode (during chunk flush) ──
        _REDIS_CONTEXT.client = mock_redis
        _REDIS_CONTEXT.defer_completions = True
        _REDIS_CONTEXT.completed_traces = completed

        root_span = {
            "trace_id": TRACE_A,
            "span_id": ROOT_SPAN,
            "parent_span_id": None,
            "span_end_time": datetime.now(UTC),
        }
        try:
            _publish_live_spans([root_span], "proj-1")
        finally:
            _REDIS_CONTEXT.client = None
            _REDIS_CONTEXT.defer_completions = False
            _REDIS_CONTEXT.completed_traces = None

        # Only the spans payload should be published — no trace_complete.
        publish_calls = mock_redis.publish.call_args_list
        assert len(publish_calls) == 1
        payload = json.loads(publish_calls[0][0][1])
        assert payload["type"] == "spans"
        # The trace_id should be recorded for deferred completion.
        assert TRACE_A in completed

    def test_publish_sends_trace_complete_when_not_deferred(self):
        """When defer_completions is False, a root span triggers trace_complete immediately."""
        mock_redis = MagicMock()

        _REDIS_CONTEXT.client = mock_redis
        _REDIS_CONTEXT.defer_completions = False
        _REDIS_CONTEXT.completed_traces = None

        root_span = {
            "trace_id": TRACE_A,
            "span_id": ROOT_SPAN,
            "parent_span_id": None,
            "span_end_time": datetime.now(UTC),
        }
        try:
            _publish_live_spans([root_span], "proj-1")
        finally:
            _REDIS_CONTEXT.client = None

        # spans + trace_complete = 2 publishes
        assert len(mock_redis.publish.call_args_list) == 2
        completion_call = mock_redis.publish.call_args_list[1]
        assert completion_call[0][0] == f"trace:live:proj-1:{TRACE_A}"
        comp_payload = json.loads(completion_call[0][1])
        assert comp_payload == {"type": "trace_complete"}

    def test_completed_traces_recorded_only_after_publish(self):
        """completed_traces.add happens after the spans publish succeeds,
        not before — so a failed publish never marks the trace as complete."""
        mock_redis = MagicMock()
        completed = set()

        # Make publish fail on the first call.
        mock_redis.publish.side_effect = ConnectionError("Redis down")

        _REDIS_CONTEXT.client = mock_redis
        _REDIS_CONTEXT.defer_completions = True
        _REDIS_CONTEXT.completed_traces = completed

        root_span = {
            "trace_id": TRACE_A,
            "span_id": ROOT_SPAN,
            "parent_span_id": None,
            "span_end_time": datetime.now(UTC),
        }
        try:
            # _publish_live_spans swallows exceptions — should not raise.
            _publish_live_spans([root_span], "proj-1")
        finally:
            _REDIS_CONTEXT.client = None
            _REDIS_CONTEXT.defer_completions = False
            _REDIS_CONTEXT.completed_traces = None

        # Trace must NOT be in completed since the publish failed.
        assert TRACE_A not in completed
