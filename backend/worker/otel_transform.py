"""Transform OTEL JSON data to ClickHouse format.

Converts OpenTelemetry trace data (camelCase JSON from protobuf) into the format
expected by our ClickHouse traces and spans tables.

OTEL JSON structure (camelCase - standard OTLP format):
{
  "resourceSpans": [
    {
      "resource": {"attributes": [...]},
      "scopeSpans": [
        {
          "scope": {"name": "...", "version": "..."},
          "spans": [
            {
              "traceId": "base64",
              "spanId": "base64",
              "parentSpanId": "base64",
              "name": "...",
              "kind": "SPAN_KIND_INTERNAL",
              "startTimeUnixNano": "123...",
              "endTimeUnixNano": "123...",
              "attributes": [{"key": "...", "value": {...}}],
              "status": {"code": "STATUS_CODE_OK"}
            }
          ]
        }
      ]
    }
  ]
}
"""

import base64
import json
import logging
from datetime import UTC, datetime
from typing import Any

from shared.enums import SpanKind, SpanStatus

logger = logging.getLogger(__name__)

# Attributes that are already extracted into dedicated fields
_KNOWN_ATTRIBUTE_PREFIXES = {
    "traceroot.span.input",
    "traceroot.span.output",
    "traceroot.span.type",
    "traceroot.span.metadata",
    "traceroot.span.tags",
    "traceroot.llm.",
    "traceroot.trace.",
    "traceroot.environment",
    "traceroot.version",
    "openinference.span.kind",
    "session.id",
    "session.user_id",
    "user.id",
    "input.value",
    "output.value",
    "gen_ai.",
    "llm.token_count.",
    "llm.model_name",
    "llm.input_messages",
    "llm.output_messages",
}


def _is_known_attribute(key: str) -> bool:
    """Check if an attribute key is already extracted into a dedicated field."""
    return any(key == prefix or key.startswith(prefix) for prefix in _KNOWN_ATTRIBUTE_PREFIXES)


def decode_otel_id(b64_value: str | None) -> str | None:
    """Decode base64-encoded OTEL trace/span ID to hex string.

    OTEL IDs are 16 bytes (trace_id) or 8 bytes (span_id), base64 encoded.
    We convert to hex for readability and storage.

    Args:
        b64_value: Base64-encoded ID string, or None

    Returns:
        Hex string representation, or None if input is None/empty
    """
    if not b64_value:
        return None
    try:
        decoded = base64.b64decode(b64_value)
        return decoded.hex()
    except Exception as e:
        logger.warning(f"Failed to decode OTEL ID '{b64_value}': {e}")
        return b64_value  # Return as-is if decoding fails


def nanos_to_datetime(nanos: int | str | None) -> datetime | None:
    """Convert nanoseconds since epoch to datetime.

    Args:
        nanos: Unix timestamp in nanoseconds (int or string representation)

    Returns:
        datetime object, or None if input is None/empty
    """
    if nanos is None:
        return None
    # MessageToDict converts large ints to strings to preserve precision
    if isinstance(nanos, str):
        if not nanos:
            return None
        nanos = int(nanos)
    # Convert nanos to seconds (float to preserve precision)
    seconds = nanos / 1_000_000_000
    return datetime.fromtimestamp(seconds, tz=UTC).replace(tzinfo=None)


def extract_attribute_value(attr_value: dict) -> Any:
    """Extract the actual value from an OTEL attribute value wrapper.

    OTEL attributes have typed values like:
    {"stringValue": "hello"} or {"intValue": 42} or {"boolValue": true}

    Uses camelCase field names (standard OTLP JSON format).

    Args:
        attr_value: OTEL attribute value dict

    Returns:
        The unwrapped value
    """
    if "stringValue" in attr_value:
        return attr_value["stringValue"]
    elif "intValue" in attr_value:
        return int(attr_value["intValue"])
    elif "boolValue" in attr_value:
        return attr_value["boolValue"]
    elif "doubleValue" in attr_value:
        return attr_value["doubleValue"]
    elif "arrayValue" in attr_value:
        return [extract_attribute_value(v) for v in attr_value["arrayValue"].get("values", [])]
    elif "kvlistValue" in attr_value:
        return {
            kv["key"]: extract_attribute_value(kv["value"])
            for kv in attr_value["kvlistValue"].get("values", [])
        }
    else:
        return None


def attributes_to_dict(attributes: list[dict]) -> dict[str, Any]:
    """Convert OTEL attributes list to a simple dict.

    Args:
        attributes: List of {"key": "...", "value": {...}} dicts

    Returns:
        Simple dict mapping keys to values
    """
    result = {}
    for attr in attributes:
        key = attr.get("key", "")
        value = attr.get("value", {})
        result[key] = extract_attribute_value(value)
    return result


def get_span_kind(attrs: dict[str, Any], otel_kind: int | str | None) -> str:
    """Determine the span kind from span attributes.

    Uses traceroot.span.type attribute if present, otherwise infers from attributes.

    Args:
        attrs: Span attributes dict
        otel_kind: OTEL span kind (int or string like "SPAN_KIND_INTERNAL")

    Returns:
        One of: "LLM", "SPAN", "AGENT", "TOOL"
    """
    # Check explicit type attribute (handle None values)
    explicit_type = (attrs.get("traceroot.span.type") or "").upper()
    if explicit_type in (SpanKind.LLM, SpanKind.SPAN, SpanKind.AGENT, SpanKind.TOOL):
        return explicit_type

    # Check OpenInference semantic conventions (handle None values)
    openinference_type = (attrs.get("openinference.span.kind") or "").upper()
    if openinference_type == SpanKind.LLM:
        return SpanKind.LLM
    elif openinference_type == SpanKind.AGENT:
        return SpanKind.AGENT
    elif openinference_type == SpanKind.TOOL:
        return SpanKind.TOOL
    elif openinference_type == "CHAIN":
        return SpanKind.SPAN

    # Default based on presence of LLM-related attributes
    if (
        attrs.get("gen_ai.system")
        or attrs.get("llm.model_name")
        or attrs.get("traceroot.llm.model")
    ):
        return SpanKind.LLM

    return SpanKind.SPAN


def _extract_user_id(attrs: dict[str, Any]) -> str | None:
    """Extract user_id from span attributes, checking multiple keys."""
    return (
        attrs.get("traceroot.trace.user_id") or attrs.get("user.id") or attrs.get("session.user_id")
    )


def _extract_session_id(attrs: dict[str, Any]) -> str | None:
    """Extract session_id from span attributes, checking multiple keys."""
    return attrs.get("traceroot.trace.session_id") or attrs.get("session.id")


def transform_otel_to_clickhouse(
    otel_data: dict,
    project_id: str,
) -> tuple[list[dict], list[dict]]:
    """Transform OTEL JSON to ClickHouse traces and spans.

    Args:
        otel_data: Parsed OTEL JSON data (camelCase format with resourceSpans)
        project_id: The project ID to associate with all records

    Returns:
        Tuple of (traces, spans) lists ready for ClickHouse insertion
    """
    traces: dict[str, dict] = {}  # trace_id -> trace record
    spans: list[dict] = []

    # Track user_id/session_id per trace, collected from ANY span
    # Priority: root span values > first child span values
    trace_attrs: dict[
        str, dict[str, str | None]
    ] = {}  # trace_id -> {"user_id": ..., "session_id": ...}

    # camelCase: resourceSpans
    resource_spans = otel_data.get("resourceSpans", [])

    for resource_span in resource_spans:
        # Extract resource attributes (common to all spans in this resource)
        resource = resource_span.get("resource", {})
        resource_attrs = attributes_to_dict(resource.get("attributes", []))

        # Get environment from resource attributes
        environment = (
            resource_attrs.get("deployment.environment")
            or resource_attrs.get("traceroot.environment")
            or resource_attrs.get("service.environment")
            or "default"
        )

        # camelCase: scopeSpans
        scope_spans = resource_span.get("scopeSpans", [])

        for scope_span in scope_spans:
            otel_spans = scope_span.get("spans", [])

            for otel_span in otel_spans:
                # Decode IDs (camelCase: traceId, spanId, parentSpanId)
                trace_id = decode_otel_id(otel_span.get("traceId"))
                span_id = decode_otel_id(otel_span.get("spanId"))
                parent_span_id = decode_otel_id(otel_span.get("parentSpanId"))

                if not trace_id or not span_id:
                    logger.warning("Skipping span with missing traceId or spanId")
                    continue

                # Parse timestamps (camelCase: startTimeUnixNano, endTimeUnixNano)
                start_time = nanos_to_datetime(otel_span.get("startTimeUnixNano"))
                end_time = nanos_to_datetime(otel_span.get("endTimeUnixNano"))

                if not start_time:
                    logger.warning(f"Skipping span {span_id} with missing startTimeUnixNano")
                    continue

                # Parse attributes
                span_attrs = attributes_to_dict(otel_span.get("attributes", []))

                # Determine span kind
                otel_kind = otel_span.get("kind")
                span_kind = get_span_kind(span_attrs, otel_kind)

                # Extract span name
                span_name = otel_span.get("name", "unknown")

                # Build span record
                span_record = {
                    "span_id": span_id,
                    "trace_id": trace_id,
                    "parent_span_id": parent_span_id,
                    "project_id": project_id,
                    "span_start_time": start_time,
                    "span_end_time": end_time,
                    "name": span_name,
                    "span_kind": span_kind,
                    "status": SpanStatus.OK,
                    "environment": environment,
                }

                # Extract input/output if present
                # Priority: traceroot SDK attrs > OpenInference attrs
                span_input = span_attrs.get("traceroot.span.input") or span_attrs.get("input.value")
                span_output = span_attrs.get("traceroot.span.output") or span_attrs.get(
                    "output.value"
                )

                if span_input is not None:
                    span_record["input"] = (
                        json.dumps(span_input) if not isinstance(span_input, str) else span_input
                    )
                if span_output is not None:
                    span_record["output"] = (
                        json.dumps(span_output) if not isinstance(span_output, str) else span_output
                    )

                # Model & token fields — extract whenever a model name is present,
                # not just for LLM spans. Auto-instrumentors (OpenInference, GenAI)
                # set model/token attrs on AGENT and CHAIN spans too.
                model_name = (
                    span_attrs.get("traceroot.llm.model")
                    or span_attrs.get("gen_ai.request.model")
                    or span_attrs.get("llm.model_name")
                )
                if model_name:
                    span_record["model_name"] = model_name

                    # Try API-provided token counts first (from instrumentors)
                    # OpenInference: llm.token_count.*
                    # GenAI semconv: gen_ai.usage.*
                    api_input_tokens = (
                        span_attrs.get("llm.token_count.prompt")
                        or span_attrs.get("gen_ai.usage.input_tokens")
                        or span_attrs.get("gen_ai.usage.prompt_tokens")
                    )
                    api_output_tokens = (
                        span_attrs.get("llm.token_count.completion")
                        or span_attrs.get("gen_ai.usage.output_tokens")
                        or span_attrs.get("gen_ai.usage.completion_tokens")
                    )
                    api_total_tokens = span_attrs.get("llm.token_count.total") or span_attrs.get(
                        "gen_ai.usage.total_tokens"
                    )

                    if api_input_tokens is not None or api_output_tokens is not None:
                        # Use API-provided counts (accurate)
                        input_tokens = int(api_input_tokens) if api_input_tokens is not None else 0
                        output_tokens = (
                            int(api_output_tokens) if api_output_tokens is not None else 0
                        )
                        total_tokens = (
                            int(api_total_tokens)
                            if api_total_tokens is not None
                            else input_tokens + output_tokens
                        )
                        span_record["input_tokens"] = input_tokens
                        span_record["output_tokens"] = output_tokens
                        span_record["total_tokens"] = total_tokens

                        # Calculate cost from actual token counts
                        from worker.tokens.pricing import get_model_price

                        prices = get_model_price(model_name)
                        if prices:
                            from decimal import Decimal

                            input_cost = (
                                Decimal(input_tokens)
                                * Decimal(str(prices["input"]))
                                / Decimal("1000000")
                            )
                            output_cost = (
                                Decimal(output_tokens)
                                * Decimal(str(prices["output"]))
                                / Decimal("1000000")
                            )
                            span_record["cost"] = float(input_cost + output_cost)
                    else:
                        # Fall back to text-based estimation
                        from worker.tokens import calculate_cost

                        usage = calculate_cost(
                            model=model_name,
                            input_text=span_record.get("input"),
                            output_text=span_record.get("output"),
                        )
                        if usage["input_tokens"] is not None:
                            span_record["input_tokens"] = usage["input_tokens"]
                        if usage["output_tokens"] is not None:
                            span_record["output_tokens"] = usage["output_tokens"]
                        if usage["total_tokens"] is not None:
                            span_record["total_tokens"] = usage["total_tokens"]
                        if usage["cost"] is not None:
                            span_record["cost"] = usage["cost"]

                # Extract metadata
                # Priority: explicit traceroot.span.metadata > remaining attributes
                explicit_metadata = span_attrs.get("traceroot.span.metadata")
                if explicit_metadata is not None:
                    if isinstance(explicit_metadata, str):
                        span_record["metadata"] = explicit_metadata
                    else:
                        span_record["metadata"] = json.dumps(explicit_metadata)
                else:
                    # Collect non-internal attributes as metadata
                    extra_attrs = {
                        k: v
                        for k, v in span_attrs.items()
                        if not _is_known_attribute(k) and v is not None
                    }
                    if extra_attrs:
                        span_record["metadata"] = json.dumps(extra_attrs)

                # Check span status for errors
                status = otel_span.get("status", {})
                status_code = status.get("code", 0)
                # Handle both int (0, 1, 2) and string ("STATUS_CODE_ERROR") formats
                if status_code == 2 or status_code == "STATUS_CODE_ERROR":
                    span_record["status"] = SpanStatus.ERROR
                    span_record["status_message"] = status.get("message")

                spans.append(span_record)

                # Collect user_id/session_id from ANY span (not just root)
                # Priority: root span values overwrite, child span values only set if empty
                span_user_id = _extract_user_id(span_attrs)
                span_session_id = _extract_session_id(span_attrs)

                if trace_id not in trace_attrs:
                    trace_attrs[trace_id] = {"user_id": None, "session_id": None}

                if not parent_span_id:
                    # Root span: always use its values if present (overwrites child values)
                    trace_attrs[trace_id]["user_id"] = (
                        span_user_id or trace_attrs[trace_id]["user_id"]
                    )
                    trace_attrs[trace_id]["session_id"] = (
                        span_session_id or trace_attrs[trace_id]["session_id"]
                    )
                else:
                    # Child span: only set if not already set (first child wins)
                    trace_attrs[trace_id]["user_id"] = (
                        trace_attrs[trace_id]["user_id"] or span_user_id
                    )
                    trace_attrs[trace_id]["session_id"] = (
                        trace_attrs[trace_id]["session_id"] or span_session_id
                    )

                # Only create trace record when we find a root span (no parent)
                # This prevents batches without root spans from creating trace
                # records with incorrect names that would overwrite the correct one
                if not parent_span_id:
                    traces[trace_id] = {
                        "trace_id": trace_id,
                        "project_id": project_id,
                        "trace_start_time": start_time,
                        "name": span_name,
                        "user_id": trace_attrs[trace_id]["user_id"],
                        "session_id": trace_attrs[trace_id]["session_id"],
                        "environment": environment,
                    }

                    # Extract trace-level metadata
                    trace_metadata = span_attrs.get("traceroot.trace.metadata")
                    if trace_metadata is not None:
                        traces[trace_id]["metadata"] = (
                            json.dumps(trace_metadata)
                            if not isinstance(trace_metadata, str)
                            else trace_metadata
                        )

                    # Root span input/output becomes trace input/output
                    if span_input is not None:
                        traces[trace_id]["input"] = (
                            json.dumps(span_input)
                            if not isinstance(span_input, str)
                            else span_input
                        )
                    if span_output is not None:
                        traces[trace_id]["output"] = (
                            json.dumps(span_output)
                            if not isinstance(span_output, str)
                            else span_output
                        )

    # Update trace records with user_id/session_id collected from child spans
    # (in case child spans with these attrs came after the root span was processed)
    for trace_id, attrs in trace_attrs.items():
        if trace_id in traces:
            if attrs["user_id"] and not traces[trace_id].get("user_id"):
                traces[trace_id]["user_id"] = attrs["user_id"]
            if attrs["session_id"] and not traces[trace_id].get("session_id"):
                traces[trace_id]["session_id"] = attrs["session_id"]

    return list(traces.values()), spans
