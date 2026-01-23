"""Context utilities for accessing current trace/span IDs.

These utility functions allow you to access the current OpenTelemetry
trace and span IDs from anywhere in your code.
"""

from opentelemetry import trace


def get_current_trace_id() -> str | None:
    """Get the current trace ID from OpenTelemetry context.

    Returns:
        The trace ID as a hex string, or None if no active span.

    Example:
        @observe()
        def my_function():
            trace_id = get_current_trace_id()
            print(f"Current trace: {trace_id}")
    """
    span = trace.get_current_span()
    if span and span.get_span_context().is_valid:
        return format(span.get_span_context().trace_id, "032x")
    return None


def get_current_span_id() -> str | None:
    """Get the current span ID from OpenTelemetry context.

    Returns:
        The span ID as a hex string, or None if no active span.

    Example:
        @observe()
        def my_function():
            span_id = get_current_span_id()
            print(f"Current span: {span_id}")
    """
    span = trace.get_current_span()
    if span and span.get_span_context().is_valid:
        return format(span.get_span_context().span_id, "016x")
    return None
