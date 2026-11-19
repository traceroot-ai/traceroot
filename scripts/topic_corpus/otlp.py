"""Send a corpus through the real ingestion path: OTLP over HTTP to the public
traces endpoint, authenticated with a project key, then the ingest worker.
"""

from __future__ import annotations

import time

import httpx
from opentelemetry.proto.collector.trace.v1.trace_service_pb2 import ExportTraceServiceRequest
from opentelemetry.proto.common.v1.common_pb2 import AnyValue, KeyValue
from opentelemetry.proto.trace.v1.trace_pb2 import ResourceSpans, ScopeSpans, Span

from scripts.topic_corpus.generate import Corpus, SpanSpec, TraceSpec

BATCH_TRACES = 25


def _attr(key: str, value: str) -> KeyValue:
    return KeyValue(key=key, value=AnyValue(string_value=value))


def _span(trace: TraceSpec, spec: SpanSpec, trace_start_ns: int) -> Span:
    start = trace_start_ns + spec.start_offset_ms * 1_000_000
    span = Span(
        trace_id=bytes.fromhex(trace.trace_id),
        span_id=bytes.fromhex(spec.span_id),
        name=spec.name,
        kind=Span.SPAN_KIND_INTERNAL,
        start_time_unix_nano=start,
        end_time_unix_nano=start + max(spec.duration_ms, 1) * 1_000_000,
    )
    if spec.parent_id:
        span.parent_span_id = bytes.fromhex(spec.parent_id)
    span.attributes.extend(
        [
            _attr("traceroot.span.type", spec.kind),
            _attr("traceroot.span.input", spec.input),
            _attr("traceroot.span.output", spec.output),
        ]
    )
    if spec.model:
        span.attributes.append(_attr("traceroot.llm.model", spec.model))
    return span


def build_request(traces: list[TraceSpec], now_ns: int) -> ExportTraceServiceRequest:
    spans: list[Span] = []
    for trace in traces:
        trace_start_ns = now_ns - trace.offset_seconds * 1_000_000_000
        spans.extend(_span(trace, s, trace_start_ns) for s in trace.spans)
    scope = ScopeSpans(spans=spans)
    scope.scope.name = "topic-corpus"
    request = ExportTraceServiceRequest()
    request.resource_spans.append(ResourceSpans(scope_spans=[scope]))
    return request


def send_corpus(corpus: Corpus, *, api_url: str, api_key: str, now_ns: int | None = None) -> int:
    """POST the corpus in batches. Returns the number of traces sent.

    Raises:
        httpx.HTTPStatusError: when the endpoint refuses a batch.
    """
    now = now_ns if now_ns is not None else time.time_ns()
    sent = 0
    with httpx.Client(timeout=60) as client:
        for i in range(0, len(corpus.traces), BATCH_TRACES):
            batch = corpus.traces[i : i + BATCH_TRACES]
            response = client.post(
                f"{api_url.rstrip('/')}/api/v1/public/traces",
                content=build_request(batch, now).SerializeToString(),
                headers={
                    "Authorization": f"Bearer {api_key}",
                    "Content-Type": "application/x-protobuf",
                },
            )
            response.raise_for_status()
            sent += len(batch)
    return sent
