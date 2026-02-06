"""Shared utilities for the Traceroot SDK."""

import enum
import json
import math
from collections.abc import Sequence
from dataclasses import asdict, is_dataclass
from datetime import date, datetime
from typing import Any
from uuid import UUID

from opentelemetry import trace

try:
    from pydantic import BaseModel as PydanticBaseModel
except ImportError:
    PydanticBaseModel = None  # type: ignore[assignment,misc]


def serialize_value(value: Any) -> Any:
    """Serialize a value to JSON-compatible types.

    Recursively converts complex objects (custom classes, dataclasses,
    pydantic models, etc.) into dicts/lists/primitives suitable for
    JSON serialization and span attribute storage.
    """
    return _serialize(value, _seen=set())


def _serialize(value: Any, _seen: set[int]) -> Any:
    """Internal recursive serializer with circular reference tracking."""
    if value is None:
        return None

    # Primitives (most common, checked first)
    if isinstance(value, str):
        return value
    if isinstance(value, bool):  # bool before int (bool is subclass of int)
        return value
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        return _serialize_float(value)

    # Collections
    if isinstance(value, dict):
        return {_serialize(k, _seen): _serialize(v, _seen) for k, v in value.items()}
    if isinstance(value, (list, tuple, set, frozenset)):
        return [_serialize(v, _seen) for v in value]

    # Standard library types
    if isinstance(value, datetime):  # datetime before date (datetime is subclass)
        return value.isoformat()
    if isinstance(value, date):
        return value.isoformat()
    if isinstance(value, UUID):
        return str(value)
    if isinstance(value, bytes):
        return _serialize_bytes(value)
    if isinstance(value, enum.Enum):
        return value.value
    if isinstance(value, (Exception, KeyboardInterrupt)):
        return f"{type(value).__name__}: {value}"

    # Structured objects (dataclass, pydantic, etc.)
    return _serialize_object(value, _seen)


def _serialize_float(value: float) -> Any:
    if math.isnan(value):
        return "NaN"
    if math.isinf(value):
        return "Infinity"
    return value


def _serialize_bytes(value: bytes) -> str:
    try:
        return value.decode("utf-8")
    except UnicodeDecodeError:
        return "<non-utf8 bytes>"


def _serialize_object(value: Any, _seen: set[int]) -> Any:
    """Serialize structured/custom objects by introspecting their attributes.

    Handles dataclasses, pydantic models, Sequence subclasses,
    and arbitrary objects with __slots__ or __dict__.
    """
    # Dataclasses (check before __dict__ since dataclasses also have __dict__)
    if is_dataclass(value) and not isinstance(value, type):
        try:
            return _serialize(asdict(value), _seen)
        except Exception:
            pass

    # Pydantic models
    if PydanticBaseModel is not None and isinstance(value, PydanticBaseModel):
        try:
            dump = value.model_dump() if hasattr(value, "model_dump") else value.dict()
            return _serialize(dump, _seen)
        except Exception:
            pass

    # Sequence-like (after str/bytes are already handled above)
    if isinstance(value, Sequence):
        return [_serialize(v, _seen) for v in value]

    # Objects with __slots__
    if hasattr(value, "__slots__"):
        attrs = {slot: getattr(value, slot, None) for slot in value.__slots__}
        return _serialize(attrs, _seen)

    # Objects with __dict__ (most custom classes)
    if hasattr(value, "__dict__"):
        return _serialize_dict_object(value, _seen)

    # Last resort — stringify
    try:
        return str(value)
    except Exception:
        return f"<{type(value).__name__}>"


def _serialize_dict_object(value: Any, _seen: set[int]) -> Any:
    """Serialize an object by introspecting __dict__, with circular ref guard.

    If the instance __dict__ is empty (e.g. attrs set on the class via
    ``type("Cls", (), {"attr": val})()``), falls back to public attributes
    from ``dir()``.
    """
    obj_id = id(value)
    if obj_id in _seen:
        return f"<circular ref: {type(value).__name__}>"

    _seen.add(obj_id)

    attrs = vars(value)
    if not attrs:
        # Class-level attributes (e.g. created via type())
        attrs = {k: getattr(value, k) for k in dir(value) if not k.startswith("_")}

    result = {k: _serialize(v, _seen) for k, v in attrs.items()}
    _seen.discard(obj_id)
    return result


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
