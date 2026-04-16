"""Metadata, IO, and status helpers for OTEL transform."""

import json
from typing import Any

from shared.enums import SpanStatus

KNOWN_ATTRIBUTE_PREFIXES = {
    "traceroot.span.input",
    "traceroot.span.output",
    "traceroot.span.type",
    "traceroot.span.metadata",
    "traceroot.span.tags",
    "traceroot.llm.",
    "traceroot.trace.",
    "traceroot.environment",
    "traceroot.git.",
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


def is_known_attribute(key: str) -> bool:
    """Check if an attribute key is already extracted into a dedicated field."""
    return any(key == prefix or key.startswith(prefix) for prefix in KNOWN_ATTRIBUTE_PREFIXES)


def serialize_io(value: Any) -> str | None:
    """Serialize non-string input/output payloads as JSON."""
    if value is None:
        return None
    return json.dumps(value) if not isinstance(value, str) else value


def apply_metadata(span_record: dict[str, Any], span_attrs: dict[str, Any]) -> None:
    """Populate span metadata with explicit metadata first, then filtered extras."""
    explicit_metadata = span_attrs.get("traceroot.span.metadata")
    if explicit_metadata is not None:
        span_record["metadata"] = (
            explicit_metadata if isinstance(explicit_metadata, str) else json.dumps(explicit_metadata)
        )
        return

    extra_attrs = {
        key: value
        for key, value in span_attrs.items()
        if not is_known_attribute(key) and value is not None
    }
    if extra_attrs:
        span_record["metadata"] = json.dumps(extra_attrs)


def apply_status(span_record: dict[str, Any], status: dict[str, Any]) -> None:
    """Apply OTEL status to a span record."""
    status_code = status.get("code", 0)
    if status_code == 2 or status_code == "STATUS_CODE_ERROR":
        span_record["status"] = SpanStatus.ERROR
        span_record["status_message"] = status.get("message")
