"""Transform OTEL JSON data to ClickHouse format.

Converts OpenTelemetry trace data (camelCase JSON from protobuf) into the format
expected by our ClickHouse traces and spans tables.
"""

from typing import Any

from .parsing import (
    attributes_to_dict,
    decode_otel_id,
    extract_attribute_value,
    get_span_kind,
    nanos_to_datetime,
)
from .span_builder import SpanRecordBuilder
from .trace_accumulator import TraceAccumulator

__all__ = [
    "attributes_to_dict",
    "decode_otel_id",
    "extract_attribute_value",
    "get_span_kind",
    "nanos_to_datetime",
    "transform_otel_to_clickhouse",
]


def transform_otel_to_clickhouse(
    otel_data: dict[str, Any],
    project_id: str,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """Transform OTEL JSON to ClickHouse traces and spans."""
    trace_accumulator = TraceAccumulator(project_id)
    span_builder = SpanRecordBuilder(project_id=project_id)
    spans: list[dict[str, Any]] = []

    for resource_span in otel_data.get("resourceSpans", []):
        for scope_span in resource_span.get("scopeSpans", []):
            for otel_span in scope_span.get("spans", []):
                context = span_builder.build(otel_span)
                if context is None:
                    continue
                spans.append(context.span_record)
                trace_accumulator.consume(context)

    return trace_accumulator.finalize(), spans
