"""Span attribute keys used by Traceroot SDK.

This module defines the OpenTelemetry span attribute keys used throughout
the SDK for consistent attribute naming.
"""


class SpanAttributes:
    """OTel span attribute keys used by Traceroot."""

    # =========================================================================
    # Span Attributes (core tracing)
    # =========================================================================
    SPAN_TYPE = "traceroot.span.type"
    SPAN_INPUT = "traceroot.span.input"
    SPAN_OUTPUT = "traceroot.span.output"
    SPAN_METADATA = "traceroot.span.metadata"
    SPAN_TAGS = "traceroot.span.tags"

    # =========================================================================
    # LLM-specific Attributes
    # =========================================================================
    LLM_MODEL = "traceroot.llm.model"
    LLM_MODEL_PARAMETERS = "traceroot.llm.model_parameters"
    LLM_USAGE = "traceroot.llm.usage"
    LLM_PROMPT = "traceroot.llm.prompt"

    # =========================================================================
    # Trace-level Attributes
    # =========================================================================
    TRACE_USER_ID = "traceroot.trace.user_id"
    TRACE_SESSION_ID = "traceroot.trace.session_id"
    TRACE_METADATA = "traceroot.trace.metadata"
    TRACE_TAGS = "traceroot.trace.tags"

    # =========================================================================
    # System Attributes
    # =========================================================================
    ENVIRONMENT = "traceroot.environment"
    VERSION = "traceroot.version"
