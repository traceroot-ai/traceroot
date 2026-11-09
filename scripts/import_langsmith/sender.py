"""Batch spans into OTLP protobuf requests and POST them to TraceRoot's ingest endpoint."""

import gzip
import logging
import time
from collections.abc import Iterable, Iterator
from typing import Any

import httpx
from opentelemetry.proto.collector.trace.v1.trace_service_pb2 import ExportTraceServiceRequest
from opentelemetry.proto.common.v1.common_pb2 import AnyValue, ArrayValue, KeyValue
from opentelemetry.proto.trace.v1.trace_pb2 import Status

from .convert import Span

logger = logging.getLogger(__name__)

SCOPE_NAME = "traceroot.import.langsmith"
SCOPE_VERSION = "0.1.0"
RETRY_STATUSES = {408, 429, 500, 502, 503, 504}


def _any_value(value: Any) -> AnyValue:
    if isinstance(value, bool):
        return AnyValue(bool_value=value)
    if isinstance(value, int):
        return AnyValue(int_value=value)
    if isinstance(value, float):
        return AnyValue(double_value=value)
    if isinstance(value, list | tuple):
        return AnyValue(array_value=ArrayValue(values=[_any_value(v) for v in value]))
    return AnyValue(string_value=str(value))


def _key_values(attributes: dict[str, Any]) -> list[KeyValue]:
    return [
        KeyValue(key=key, value=_any_value(value))
        for key, value in attributes.items()
        if value is not None
    ]


def build_request(
    spans: Iterable[Span], resource_attributes: dict[str, Any]
) -> ExportTraceServiceRequest:
    request = ExportTraceServiceRequest()
    resource_spans = request.resource_spans.add()
    resource_spans.resource.attributes.extend(_key_values(resource_attributes))
    scope_spans = resource_spans.scope_spans.add()
    scope_spans.scope.name = SCOPE_NAME
    scope_spans.scope.version = SCOPE_VERSION
    for span in spans:
        out = scope_spans.spans.add()
        out.trace_id = span.trace_id
        out.span_id = span.span_id
        if span.parent_span_id:
            out.parent_span_id = span.parent_span_id
        out.name = span.name
        out.kind = 1  # SPAN_KIND_INTERNAL
        out.start_time_unix_nano = span.start_ns
        out.end_time_unix_nano = span.end_ns
        out.status.code = Status.StatusCode.Value(
            ("STATUS_CODE_UNSET", "STATUS_CODE_OK", "STATUS_CODE_ERROR")[span.status_code]
        )
        if span.status_message:
            out.status.message = span.status_message
        out.attributes.extend(_key_values(span.attributes))
    return request


def batches(spans: Iterable[Span], max_spans: int, max_bytes: int) -> Iterator[list[Span]]:
    """Group spans by count and approximate attribute size."""
    batch: list[Span] = []
    size = 0
    for span in spans:
        span_size = sum(len(str(v)) for v in span.attributes.values()) + 200
        if batch and (len(batch) >= max_spans or size + span_size > max_bytes):
            yield batch
            batch, size = [], 0
        batch.append(span)
        size += span_size
    if batch:
        yield batch


class Sender:
    """POSTs gzipped OTLP batches with retries and a minimum interval between requests."""

    def __init__(
        self,
        host_url: str,
        api_key: str,
        *,
        min_interval: float = 0.2,
        max_retries: int = 5,
        timeout: float = 60.0,
        client: httpx.Client | None = None,
    ):
        self.endpoint = f"{host_url.rstrip('/')}/api/v1/public/traces"
        self.min_interval = min_interval
        self.max_retries = max_retries
        self._last_sent = 0.0
        self._client = client or httpx.Client(timeout=timeout, follow_redirects=True)
        self._headers = {
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/x-protobuf",
            "Content-Encoding": "gzip",
            "x-traceroot-sdk-name": "traceroot-import-langsmith",
            "x-traceroot-sdk-version": SCOPE_VERSION,
        }

    def send(self, request: ExportTraceServiceRequest) -> None:
        body = gzip.compress(request.SerializeToString())
        for attempt in range(self.max_retries + 1):
            wait = self.min_interval - (time.monotonic() - self._last_sent)
            if wait > 0:
                time.sleep(wait)
            self._last_sent = time.monotonic()
            try:
                response = self._client.post(self.endpoint, content=body, headers=self._headers)
            except httpx.TransportError as exc:
                if attempt == self.max_retries:
                    raise
                logger.warning("Ingest request failed (%s); retrying", exc)
                time.sleep(2**attempt)
                continue
            if response.status_code < 300:
                return
            if response.status_code in RETRY_STATUSES and attempt < self.max_retries:
                retry_after = response.headers.get("retry-after", "")
                delay = float(retry_after) if retry_after.isdigit() else 2**attempt
                logger.warning("Ingest returned %s; retrying in %.0fs", response.status_code, delay)
                time.sleep(delay)
                continue
            raise RuntimeError(
                f"Ingest failed with HTTP {response.status_code}: {response.text[:500]}"
            )
