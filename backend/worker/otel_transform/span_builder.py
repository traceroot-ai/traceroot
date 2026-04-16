"""Span record building for OTEL transform."""

import logging
from dataclasses import dataclass
from datetime import datetime
from typing import Any

from shared.enums import SpanStatus

from .metadata import apply_metadata, apply_status, serialize_io
from .parsing import (
    attributes_to_dict,
    decode_otel_id,
    get_span_kind,
    nanos_to_datetime,
)
from .tokens import TokenCalculator

logger = logging.getLogger(__name__)


@dataclass
class SpanContext:
    trace_id: str
    parent_span_id: str | None
    span_name: str
    start_time: datetime
    span_input: Any
    span_output: Any
    span_attrs: dict[str, Any]
    span_record: dict[str, Any]


class SpanRecordBuilder:
    """Build span records from OTEL spans."""

    def __init__(self, project_id: str, token_calculator: TokenCalculator | None = None):
        self._project_id = project_id
        self._token_calculator = token_calculator

    def _apply_usage(self, span_record: dict[str, Any], span_attrs: dict[str, Any]) -> None:
        if TokenCalculator.extract_model_name(span_attrs) is None:
            return

        if self._token_calculator is None:
            self._token_calculator = TokenCalculator.from_runtime()

        self._token_calculator.apply_usage(span_record, span_attrs)

    def build(self, otel_span: dict[str, Any]) -> SpanContext | None:
        trace_id = decode_otel_id(otel_span.get("traceId"))
        span_id = decode_otel_id(otel_span.get("spanId"))
        parent_span_id = decode_otel_id(otel_span.get("parentSpanId"))

        if not trace_id or not span_id:
            logger.warning("Skipping span with missing traceId or spanId")
            return None

        start_time = nanos_to_datetime(otel_span.get("startTimeUnixNano"))
        end_time = nanos_to_datetime(otel_span.get("endTimeUnixNano"))
        if not start_time:
            logger.warning("Skipping span %s with missing startTimeUnixNano", span_id)
            return None

        span_attrs = attributes_to_dict(otel_span.get("attributes", []))
        span_name = otel_span.get("name", "unknown")

        span_record: dict[str, Any] = {
            "span_id": span_id,
            "trace_id": trace_id,
            "parent_span_id": parent_span_id,
            "project_id": self._project_id,
            "span_start_time": start_time,
            "span_end_time": end_time,
            "name": span_name,
            "span_kind": get_span_kind(span_attrs, otel_span.get("kind")),
            "status": SpanStatus.OK,
        }

        git_source_file = span_attrs.get("traceroot.git.source_file")
        git_source_line = span_attrs.get("traceroot.git.source_line")
        git_source_function = span_attrs.get("traceroot.git.source_function")
        if git_source_file is not None:
            span_record["git_source_file"] = git_source_file
        if git_source_line is not None:
            span_record["git_source_line"] = git_source_line
        if git_source_function is not None:
            span_record["git_source_function"] = git_source_function

        span_input = span_attrs.get("traceroot.span.input") or span_attrs.get("input.value")
        span_output = span_attrs.get("traceroot.span.output") or span_attrs.get("output.value")
        serialized_input = serialize_io(span_input)
        serialized_output = serialize_io(span_output)
        if serialized_input is not None:
            span_record["input"] = serialized_input
        if serialized_output is not None:
            span_record["output"] = serialized_output

        self._apply_usage(span_record, span_attrs)
        apply_metadata(span_record, span_attrs)
        apply_status(span_record, otel_span.get("status", {}))

        return SpanContext(
            trace_id=trace_id,
            parent_span_id=parent_span_id,
            span_name=span_name,
            start_time=start_time,
            span_input=span_input,
            span_output=span_output,
            span_attrs=span_attrs,
            span_record=span_record,
        )
