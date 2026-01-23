"""Shared utilities for the Traceroot SDK."""

import json
from typing import Any

from opentelemetry import trace


def serialize_value(value: Any) -> Any:
    """Serialize a value for storage.

    Recursively converts complex objects to JSON-serializable types.
    """
    if value is None:
        return None
    if isinstance(value, (str, int, float, bool)):
        return value
    if isinstance(value, (list, tuple)):
        return [serialize_value(v) for v in value]
    if isinstance(value, dict):
        return {k: serialize_value(v) for k, v in value.items()}
    # For complex objects, convert to string representation
    try:
        return str(value)
    except Exception:
        return f"<{type(value).__name__}>"


def set_span_attribute(span: trace.Span, key: str, value: Any) -> None:
    """Set a span attribute, serializing complex types to JSON.

    Does nothing if value is None or span is not recording.
    """
    if value is None:
        return
    if not span.is_recording():
        return

    if isinstance(value, (str, int, float, bool)):
        span.set_attribute(key, value)
    elif isinstance(value, list) and all(isinstance(v, str) for v in value):
        # OTel supports list of strings natively
        span.set_attribute(key, value)
    else:
        # Serialize complex types to JSON string
        span.set_attribute(key, json.dumps(serialize_value(value)))
