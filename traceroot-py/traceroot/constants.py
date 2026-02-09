"""Constants used by the Traceroot SDK.

This module defines constants used throughout the SDK including default values,
tracer identification, and type definitions.
"""

import enum

# =============================================================================
# SDK Identification
# =============================================================================

TRACEROOT_TRACER_NAME = "traceroot-sdk"
"""OpenTelemetry tracer/instrumentation scope name for Traceroot spans."""

SDK_NAME = "traceroot-python"
"""SDK name for identification in API requests."""

SDK_VERSION = "0.1.0"
"""SDK version. Should match pyproject.toml version."""

# =============================================================================
# Default Values
# =============================================================================

DEFAULT_HOST_URL = "https://api.traceroot.ai"
"""Default Traceroot API endpoint."""

DEFAULT_FLUSH_AT = 100
"""Default maximum batch size before triggering a flush."""

DEFAULT_FLUSH_INTERVAL = 5.0
"""Default interval in seconds between automatic flushes."""

DEFAULT_TIMEOUT = 30.0
"""Default HTTP request timeout in seconds."""

DEFAULT_ENVIRONMENT = "default"
"""Default tracing environment name."""

DEFAULT_SERVICE_NAME = "unknown_service"
"""Default service name when not specified."""

# =============================================================================
# Span Kinds
# =============================================================================


class SpanKind(enum.StrEnum):
    """Valid span kinds for the @observe decorator.

    Members work as plain strings everywhere (comparisons, f-strings, OTel
    attributes) while giving dot-access syntax like ``SpanKind.AGENT``.

    These lowercase values are sent as the ``traceroot.span.type`` OTEL attribute.
    The backend transformer uppercases them and maps to the ClickHouse enum.
    """

    SPAN = "span"
    AGENT = "agent"
    TOOL = "tool"
    LLM = "llm"
