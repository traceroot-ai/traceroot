"""Tests for the streaming transform API (TransformContext + iter_transform_spans).

Verifies that the streaming generator produces identical output to the original
monolithic ``transform_otel_to_clickhouse``, and that TransformContext correctly
accumulates and finalizes trace-level metadata across spans.
"""

import types
from typing import Generator

import pytest

from tests.fixtures.otel_payloads import (
    make_attr,
    make_eval_trace,
    make_otel_payload,
    make_span,
)
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
        assert isinstance(result, Generator) or isinstance(result, types.GeneratorType)

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
        payload = make_otel_payload([
            make_span(TRACE_A, ROOT_SPAN, name="root"),
            make_span(TRACE_A, CHILD_SPAN, name="child", parent_span_id_hex=ROOT_SPAN),
        ])
        ctx = TransformContext(project_id="proj-1")
        list(iter_transform_spans(payload, "proj-1", ctx))
        assert TRACE_A in ctx.root_bearing_trace_ids

    def test_child_only_trace_not_root_bearing(self):
        """A trace with only child spans (no root) is not root-bearing."""
        payload = make_otel_payload([
            make_span(TRACE_A, CHILD_SPAN, name="child", parent_span_id_hex=ROOT_SPAN),
        ])
        ctx = TransformContext(project_id="proj-1")
        list(iter_transform_spans(payload, "proj-1", ctx))
        assert TRACE_A not in ctx.root_bearing_trace_ids

    def test_parent_child_spans(self):
        """Both parent and child spans are yielded and trace is resolved."""
        payload = make_otel_payload([
            make_span(TRACE_A, ROOT_SPAN, name="root"),
            make_span(TRACE_A, CHILD_SPAN, name="child", parent_span_id_hex=ROOT_SPAN),
        ])
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
        payload = make_otel_payload([
            make_span(TRACE_A, ROOT_SPAN, attributes=[
                make_attr("traceroot.span.type", "LLM"),
            ]),
        ])
        ctx = TransformContext(project_id="proj-1")
        spans = list(iter_transform_spans(payload, "proj-1", ctx))
        assert spans[0]["span_kind"] == "LLM"

    def test_span_kind_openinference_tool(self):
        """OpenInference TOOL kind is recognized."""
        payload = make_otel_payload([
            make_span(TRACE_A, ROOT_SPAN, attributes=[
                make_attr("openinference.span.kind", "TOOL"),
            ]),
        ])
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
        payload = make_otel_payload([
            make_span(TRACE_A, ROOT_SPAN, attributes=[
                make_attr("traceroot.span.input", "hello world"),
                make_attr("traceroot.span.output", "goodbye world"),
            ]),
        ])
        ctx = TransformContext(project_id="proj-1")
        spans = list(iter_transform_spans(payload, "proj-1", ctx))
        assert spans[0]["input"] == "hello world"
        assert spans[0]["output"] == "goodbye world"

    def test_skips_spans_without_trace_id(self):
        """Spans with missing traceId are skipped."""
        payload = {
            "resourceSpans": [{
                "resource": {"attributes": []},
                "scopeSpans": [{
                    "scope": {"name": "test"},
                    "spans": [{
                        "spanId": "AQAAAAAAAAAA",  # valid base64
                        "name": "orphan",
                        "startTimeUnixNano": "1705320000000000000",
                        "endTimeUnixNano": "1705320001000000000",
                        "attributes": [],
                        "status": {"code": 0},
                    }],
                }],
            }],
        }
        ctx = TransformContext(project_id="proj-1")
        spans = list(iter_transform_spans(payload, "proj-1", ctx))
        assert spans == []

    def test_multiple_traces(self):
        """Spans from different traces yield correctly and create separate trace records."""
        payload = make_otel_payload([
            make_span(TRACE_A, ROOT_SPAN, name="trace-a"),
            make_span(TRACE_B, CHILD_SPAN, name="trace-b"),
        ])
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
        payload = make_otel_payload([
            make_span(TRACE_A, ROOT_SPAN, attributes=[
                make_attr("traceroot.environment", "production"),
            ]),
        ])
        ctx = TransformContext(project_id="proj-1")
        list(iter_transform_spans(payload, "proj-1", ctx))
        traces = ctx.finalize_traces()
        assert traces[0].get("environment") == "production"

    def test_user_id_session_id_from_root(self):
        """user_id and session_id from root span land on the trace."""
        payload = make_otel_payload([
            make_span(TRACE_A, ROOT_SPAN, attributes=[
                make_attr("traceroot.trace.user_id", "alice"),
                make_attr("traceroot.trace.session_id", "sess-1"),
            ]),
        ])
        ctx = TransformContext(project_id="proj-1")
        list(iter_transform_spans(payload, "proj-1", ctx))
        traces = ctx.finalize_traces()
        assert traces[0]["user_id"] == "alice"
        assert traces[0]["session_id"] == "sess-1"

    def test_user_id_from_child_when_root_missing(self):
        """Child span's user_id fills in when root has none."""
        payload = make_otel_payload([
            make_span(TRACE_A, CHILD_SPAN, parent_span_id_hex=ROOT_SPAN, attributes=[
                make_attr("traceroot.trace.user_id", "bob"),
            ]),
        ])
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
        payload = make_otel_payload([
            make_span(TRACE_A, ROOT_SPAN, name="root"),
            make_span(TRACE_A, CHILD_SPAN, name="child", parent_span_id_hex=ROOT_SPAN),
            make_span(
                TRACE_A, GRANDCHILD_SPAN, name="grandchild",
                parent_span_id_hex=CHILD_SPAN,
            ),
        ])
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
        payload = make_otel_payload([
            make_span(TRACE_A, ROOT_SPAN, name="root", attributes=[
                make_attr("traceroot.span.type", "LLM"),
                make_attr("traceroot.span.input", "hello"),
                make_attr("traceroot.span.output", "world"),
                make_attr("traceroot.environment", "prod"),
                make_attr("gen_ai.request.model", "gpt-4"),
            ]),
        ])
        wrapper_traces, wrapper_spans = transform_otel_to_clickhouse(payload, "proj-1")
        stream_traces, stream_spans = self._streaming_result(payload)

        # Every key in the wrapper span must also exist in the streaming span
        for key in wrapper_spans[0]:
            assert key in stream_spans[0], f"Missing key in streaming span: {key}"
            assert wrapper_spans[0][key] == stream_spans[0][key], (
                f"Mismatch for key {key}: wrapper={wrapper_spans[0][key]!r}, "
                f"stream={stream_spans[0][key]!r}"
            )


# ── Chunked Consumer Pattern ────────────────────────────────────────────


class TestChunkedConsumer:
    """Tests for consuming iter_transform_spans in bounded-memory chunks."""

    def _make_large_payload(self, n_spans: int) -> dict:
        """Build a payload with n_spans child spans under one root."""
        spans = [make_span(TRACE_A, ROOT_SPAN, name="root")]
        for i in range(n_spans - 1):
            span_id = f"{i + 2:016x}"
            spans.append(make_span(
                TRACE_A, span_id, name=f"child-{i}",
                parent_span_id_hex=ROOT_SPAN,
            ))
        return make_otel_payload(spans)

    def test_chunked_processes_all_spans(self):
        """All spans are processed regardless of chunk size."""
        payload = self._make_large_payload(50)
        ctx = TransformContext(project_id="proj-1")

        total = 0
        chunk_size = 10
        chunk = []
        for span in iter_transform_spans(payload, "proj-1", ctx):
            chunk.append(span)
            if len(chunk) >= chunk_size:
                total += len(chunk)
                chunk.clear()
        if chunk:
            total += len(chunk)
            chunk.clear()

        assert total == 50

    def test_chunk_sizes_bounded(self):
        """Each chunk is at most chunk_size spans."""
        payload = self._make_large_payload(27)
        ctx = TransformContext(project_id="proj-1")

        chunk_size = 10
        chunk_sizes = []
        chunk = []
        for span in iter_transform_spans(payload, "proj-1", ctx):
            chunk.append(span)
            if len(chunk) >= chunk_size:
                chunk_sizes.append(len(chunk))
                chunk.clear()
        if chunk:
            chunk_sizes.append(len(chunk))

        # 27 spans / 10 per chunk = [10, 10, 7]
        assert chunk_sizes == [10, 10, 7]

    def test_trace_finalization_after_exhaustion(self):
        """Traces are finalized correctly after all chunks are consumed."""
        payload = self._make_large_payload(20)
        ctx = TransformContext(project_id="proj-1")

        chunk_size = 5
        chunk = []
        for span in iter_transform_spans(payload, "proj-1", ctx):
            chunk.append(span)
            if len(chunk) >= chunk_size:
                chunk.clear()
        chunk.clear()

        # Despite chunked consumption, traces are correct
        traces = ctx.finalize_traces()
        assert len(traces) == 1
        assert traces[0]["trace_id"] == TRACE_A
        assert traces[0]["name"] == "root"

    def test_root_bearing_ids_correct_after_chunked(self):
        """root_bearing_trace_ids is correct after chunked consumption."""
        payload = self._make_large_payload(15)
        ctx = TransformContext(project_id="proj-1")

        for span in iter_transform_spans(payload, "proj-1", ctx):
            pass  # consume all

        assert ctx.root_bearing_trace_ids == {TRACE_A}

    def test_single_span_chunk(self):
        """Chunk size of 1 still works correctly."""
        payload = self._make_large_payload(5)
        ctx = TransformContext(project_id="proj-1")

        chunks_processed = 0
        for span in iter_transform_spans(payload, "proj-1", ctx):
            chunks_processed += 1

        assert chunks_processed == 5
        traces = ctx.finalize_traces()
        assert len(traces) == 1


# ── Flush Span Chunk (ingest_tasks helper) ──────────────────────────────


class TestFlushSpanChunkImport:
    """Verify the _flush_span_chunk helper is importable and callable."""

    def test_importable(self):
        from worker.ingest_tasks import _flush_span_chunk

        assert callable(_flush_span_chunk)

