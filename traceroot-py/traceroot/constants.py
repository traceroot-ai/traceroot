"""Constants used by the Traceroot SDK.

This module defines constants used throughout the SDK including default values,
tracer identification, and type definitions.
"""

from typing import Literal

# Re-export SpanAttributes for backwards compatibility
from traceroot.span_attributes import SpanAttributes

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
# Step Types
# =============================================================================

StepType = Literal["span", "agent", "tool", "llm"]
"""Valid step types for the @observe decorator."""

