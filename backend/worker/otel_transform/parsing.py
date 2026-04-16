"""Parsing helpers for OTEL transform."""

import base64
import logging
from datetime import UTC, datetime
from typing import Any

from shared.enums import SpanKind

logger = logging.getLogger(__name__)


def decode_otel_id(b64_value: str | None) -> str | None:
    """Decode base64-encoded OTEL trace/span IDs to hex strings."""
    if not b64_value:
        return None
    try:
        return base64.b64decode(b64_value).hex()
    except Exception as exc:
        logger.warning("Failed to decode OTEL ID '%s': %s", b64_value, exc)
        return b64_value


def nanos_to_datetime(nanos: int | str | None) -> datetime | None:
    """Convert nanoseconds since epoch to naive UTC datetime."""
    if nanos is None:
        return None
    if isinstance(nanos, str):
        if not nanos:
            return None
        nanos = int(nanos)
    seconds = nanos / 1_000_000_000
    return datetime.fromtimestamp(seconds, tz=UTC).replace(tzinfo=None)


def extract_attribute_value(attr_value: dict[str, Any]) -> Any:
    """Extract the unwrapped value from an OTEL attribute wrapper."""
    if "stringValue" in attr_value:
        return attr_value["stringValue"]
    if "intValue" in attr_value:
        return int(attr_value["intValue"])
    if "boolValue" in attr_value:
        return attr_value["boolValue"]
    if "doubleValue" in attr_value:
        return attr_value["doubleValue"]
    if "arrayValue" in attr_value:
        return [
            extract_attribute_value(value) for value in attr_value["arrayValue"].get("values", [])
        ]
    if "kvlistValue" in attr_value:
        return {
            item["key"]: extract_attribute_value(item["value"])
            for item in attr_value["kvlistValue"].get("values", [])
        }
    return None


def attributes_to_dict(attributes: list[dict[str, Any]]) -> dict[str, Any]:
    """Convert OTEL attributes list to a simple dict."""
    result: dict[str, Any] = {}
    for attr in attributes:
        result[attr.get("key", "")] = extract_attribute_value(attr.get("value", {}))
    return result


def get_span_kind(attrs: dict[str, Any], otel_kind: int | str | None) -> str:
    """Determine the span kind from span attributes."""
    del otel_kind

    explicit_type = (attrs.get("traceroot.span.type") or "").upper()
    if explicit_type in (SpanKind.LLM, SpanKind.SPAN, SpanKind.AGENT, SpanKind.TOOL):
        return explicit_type

    openinference_type = (attrs.get("openinference.span.kind") or "").upper()
    if openinference_type == SpanKind.LLM:
        return SpanKind.LLM
    if openinference_type == SpanKind.AGENT:
        return SpanKind.AGENT
    if openinference_type == SpanKind.TOOL:
        return SpanKind.TOOL
    if openinference_type == "CHAIN":
        return SpanKind.SPAN

    if (
        attrs.get("gen_ai.system")
        or attrs.get("llm.model_name")
        or attrs.get("traceroot.llm.model")
    ):
        return SpanKind.LLM

    return SpanKind.SPAN


def extract_user_id(attrs: dict[str, Any]) -> str | None:
    """Extract user_id from span attributes, checking multiple keys."""
    return (
        attrs.get("traceroot.trace.user_id") or attrs.get("user.id") or attrs.get("session.user_id")
    )


def extract_session_id(attrs: dict[str, Any]) -> str | None:
    """Extract session_id from span attributes, checking multiple keys."""
    return attrs.get("traceroot.trace.session_id") or attrs.get("session.id")
