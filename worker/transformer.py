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
from datetime import datetime, timezone
from typing import Any

logger = logging.getLogger(__name__)


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
    return datetime.fromtimestamp(seconds, tz=timezone.utc).replace(tzinfo=None)


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
    if explicit_type in ("LLM", "SPAN", "AGENT", "TOOL"):
        return explicit_type

    # Check OpenInference semantic conventions (handle None values)
    openinference_type = (attrs.get("openinference.span.kind") or "").upper()
    if openinference_type == "LLM":
        return "LLM"
    elif openinference_type == "AGENT":
        return "AGENT"
    elif openinference_type == "TOOL":
        return "TOOL"
    elif openinference_type == "CHAIN":
        return "SPAN"

    # Default based on presence of LLM-related attributes
    if attrs.get("gen_ai.system") or attrs.get("llm.model_name") or attrs.get("traceroot.llm.model"):
        return "LLM"

    return "SPAN"


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
                    "status": "OK",
                    "environment": environment,
                }

                # Extract input/output if present
                span_input = span_attrs.get("traceroot.span.input")
                span_output = span_attrs.get("traceroot.span.output")

                if span_input is not None:
                    span_record["input"] = (
                        json.dumps(span_input) if not isinstance(span_input, str) else span_input
                    )
                if span_output is not None:
                    span_record["output"] = (
                        json.dumps(span_output) if not isinstance(span_output, str) else span_output
                    )

                # LLM-specific fields
                if span_kind == "LLM":
                    model_name = (
                        span_attrs.get("traceroot.llm.model")
                        or span_attrs.get("gen_ai.request.model")
                        or span_attrs.get("llm.model_name")
                    )
                    if model_name:
                        span_record["model_name"] = model_name

                # Check span status for errors
                status = otel_span.get("status", {})
                status_code = status.get("code", 0)
                # Handle both int (0, 1, 2) and string ("STATUS_CODE_ERROR") formats
                if status_code == 2 or status_code == "STATUS_CODE_ERROR":
                    span_record["status"] = "ERROR"
                    span_record["status_message"] = status.get("message")

                spans.append(span_record)

                # Track trace (create/update)
                if trace_id not in traces:
                    # Get user/session from attributes
                    user_id = (
                        span_attrs.get("traceroot.trace.user_id")
                        or span_attrs.get("user.id")
                        or span_attrs.get("session.user_id")
                    )
                    session_id = (
                        span_attrs.get("traceroot.trace.session_id")
                        or span_attrs.get("session.id")
                    )

                    traces[trace_id] = {
                        "trace_id": trace_id,
                        "project_id": project_id,
                        "trace_start_time": start_time,
                        "name": span_name,  # Will be updated if we find root span
                        "user_id": user_id,
                        "session_id": session_id,
                        "environment": environment,
                    }

                # Update trace with root span info (span without parent)
                if not parent_span_id and trace_id in traces:
                    traces[trace_id]["name"] = span_name
                    traces[trace_id]["trace_start_time"] = start_time

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

    return list(traces.values()), spans
