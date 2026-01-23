"""Functions to update the current span or trace with additional data.

These functions allow manual enrichment of spans when auto-instrumentation
doesn't capture all the data you need (e.g., custom LLM providers).
"""

import logging
from typing import Any

from opentelemetry import trace

from traceroot.span_attributes import SpanAttributes
from traceroot.utils import set_span_attribute

logger = logging.getLogger(__name__)


def update_current_span(
    *,
    name: str | None = None,
    input: Any | None = None,
    output: Any | None = None,
    metadata: dict[str, Any] | None = None,
    # LLM-specific attributes
    model: str | None = None,
    model_parameters: dict[str, Any] | None = None,
    usage: dict[str, int] | None = None,
    prompt: Any | None = None,
) -> None:
    """Update the current active span with additional information.

    This is useful for adding data that becomes available during execution,
    such as LLM responses, token usage, or the actual prompt sent to a model.

    Args:
        name: Update the span name.
        input: Input data (e.g., messages sent to LLM).
        output: Output data (e.g., LLM response).
        metadata: Additional metadata as key-value pairs.
        model: LLM model name (e.g., "gpt-4o", "claude-3-opus").
        model_parameters: Model parameters (e.g., temperature, max_tokens).
        usage: Token usage dict (e.g., {"input_tokens": 100, "output_tokens": 50}).
        prompt: The prompt/messages sent to the LLM.

    Example:
        @observe(type="llm")
        def call_custom_llm(query: str):
            messages = [{"role": "user", "content": query}]

            # Update with the actual prompt being sent
            traceroot.update_current_span(
                prompt=messages,
                model="custom-llm-v1"
            )

            response = custom_llm.generate(messages)

            # Update with output and usage
            traceroot.update_current_span(
                output=response.text,
                usage={"input_tokens": 100, "output_tokens": 50}
            )
            return response.text
    """
    span = trace.get_current_span()

    if span is None or not span.is_recording():
        logger.debug("update_current_span: No active recording span found.")
        return

    # Update span name if provided
    if name is not None:
        span.update_name(name)

    # Core span attributes
    set_span_attribute(span, SpanAttributes.SPAN_INPUT, input)
    set_span_attribute(span, SpanAttributes.SPAN_OUTPUT, output)
    set_span_attribute(span, SpanAttributes.SPAN_METADATA, metadata)

    # LLM-specific attributes
    set_span_attribute(span, SpanAttributes.LLM_MODEL, model)
    set_span_attribute(span, SpanAttributes.LLM_MODEL_PARAMETERS, model_parameters)
    set_span_attribute(span, SpanAttributes.LLM_USAGE, usage)
    set_span_attribute(span, SpanAttributes.LLM_PROMPT, prompt)


def update_current_trace(
    *,
    user_id: str | None = None,
    session_id: str | None = None,
    metadata: dict[str, Any] | None = None,
    tags: list[str] | None = None,
) -> None:
    """Update the current trace with additional information.

    This sets trace-level attributes on the current span. These attributes
    are useful for filtering and grouping traces in the Traceroot UI.

    Args:
        user_id: ID of the user who initiated the trace.
        session_id: Session identifier for grouping related traces.
        metadata: Additional metadata for the trace.
        tags: List of tags to categorize the trace.

    Example:
        @observe(type="agent")
        def handle_request(request):
            # Set trace context
            traceroot.update_current_trace(
                user_id=request.user_id,
                session_id=request.session_id,
                tags=["production", "v2"]
            )

            return process(request)
    """
    span = trace.get_current_span()

    if span is None or not span.is_recording():
        logger.debug("update_current_trace: No active recording span found.")
        return

    # Trace-level attributes
    set_span_attribute(span, SpanAttributes.TRACE_USER_ID, user_id)
    set_span_attribute(span, SpanAttributes.TRACE_SESSION_ID, session_id)
    set_span_attribute(span, SpanAttributes.TRACE_METADATA, metadata)
    set_span_attribute(span, SpanAttributes.TRACE_TAGS, tags)
