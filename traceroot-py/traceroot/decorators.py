"""Decorator-based instrumentation using OpenTelemetry."""

import functools
import inspect
import logging
from collections.abc import Callable
from typing import Any, TypeVar

from openinference.instrumentation import get_attributes_from_context
from opentelemetry import trace
from opentelemetry.trace import Status, StatusCode

from traceroot.constants import SpanKind
from traceroot.git_context import capture_source_location
from traceroot.span_attributes import SpanAttributes
from traceroot.utils import serialize_value, set_span_attribute

logger = logging.getLogger(__name__)

F = TypeVar("F", bound=Callable[..., Any])


def _ensure_initialized() -> None:
    """Ensure traceroot client is initialized (for auto-init from env vars).

    This enables lazy initialization - the @observe decorator works
    without explicit traceroot.initialize() if env vars are set.

    Note: This doesn't block tracing if client is disabled. The decorator
    always creates spans using whatever TracerProvider is configured.
    """
    # Import here to avoid circular import
    from traceroot import get_client

    get_client()  # auto-initializes if needed


def observe(
    name: str | None = None,
    type: SpanKind = SpanKind.SPAN,
    metadata: dict[str, Any] | None = None,
    tags: list[str] | None = None,
    capture_input: bool = True,
    capture_output: bool = True,
) -> Callable[[F], F]:
    """Decorator to create an OpenTelemetry span for a function.

    Args:
        name: Span name. Defaults to function name.
        type: Span kind. Valid values: 'llm', 'span', 'agent', 'tool'.
            - 'llm': For LLM/generation calls
            - 'span': General span (default)
            - 'agent': For agent operations
            - 'tool': For tool/function calls
        metadata: Static metadata to attach.
        tags: Tags to attach.
        capture_input: Whether to capture function arguments.
        capture_output: Whether to capture return value.

    Returns:
        Decorated function.

    Example:
        @observe(name="my_agent", type="agent")
        def my_agent(query: str) -> str:
            return process(query)

        @observe(type="tool")
        def search_web(query: str) -> list[str]:
            return results

        @observe(type="llm")
        def call_openai(messages: list) -> str:
            return response
    """
    # Validate type parameter — accept raw strings too
    try:
        validated_kind = SpanKind(type)
    except ValueError:
        valid = ", ".join(m.value for m in SpanKind)
        logger.warning(
            f"Invalid span kind '{type}'. Valid kinds are: {valid}. Defaulting to 'span'."
        )
        validated_kind = SpanKind.SPAN

    def decorator(func: F) -> F:
        span_name = name or func.__name__

        if inspect.iscoroutinefunction(func):

            @functools.wraps(func)
            async def async_wrapper(*args: Any, **kwargs: Any) -> Any:
                _ensure_initialized()
                tracer = trace.get_tracer("traceroot-sdk", "0.1.0")
                with tracer.start_as_current_span(span_name) as span:
                    _set_span_attributes(
                        span, validated_kind, metadata, tags, args, kwargs, func, capture_input
                    )

                    # Auto-capture source location
                    source = capture_source_location()
                    if source.get("git_source_file"):
                        span.set_attribute(
                            SpanAttributes.GIT_SOURCE_FILE, source["git_source_file"]
                        )
                    if source.get("git_source_line"):
                        span.set_attribute(
                            SpanAttributes.GIT_SOURCE_LINE, source["git_source_line"]
                        )
                    if source.get("git_source_function"):
                        span.set_attribute(
                            SpanAttributes.GIT_SOURCE_FUNCTION, source["git_source_function"]
                        )

                    # Set trace-level git context from client
                    from traceroot import get_client

                    client = get_client()
                    if client and client.git_repo:
                        span.set_attribute(SpanAttributes.GIT_REPO, client.git_repo)
                    if client and client.git_ref:
                        span.set_attribute(SpanAttributes.GIT_REF, client.git_ref)

                    try:
                        result = await func(*args, **kwargs)
                        if capture_output and result is not None:
                            _set_output(span, result)
                        return result
                    except Exception as e:
                        span.set_status(Status(StatusCode.ERROR, str(e)))
                        span.record_exception(e)
                        raise

            return async_wrapper  # type: ignore

        else:

            @functools.wraps(func)
            def sync_wrapper(*args: Any, **kwargs: Any) -> Any:
                _ensure_initialized()
                tracer = trace.get_tracer("traceroot-sdk", "0.1.0")
                with tracer.start_as_current_span(span_name) as span:
                    _set_span_attributes(
                        span, validated_kind, metadata, tags, args, kwargs, func, capture_input
                    )

                    # Auto-capture source location
                    source = capture_source_location()
                    if source.get("git_source_file"):
                        span.set_attribute(
                            SpanAttributes.GIT_SOURCE_FILE, source["git_source_file"]
                        )
                    if source.get("git_source_line"):
                        span.set_attribute(
                            SpanAttributes.GIT_SOURCE_LINE, source["git_source_line"]
                        )
                    if source.get("git_source_function"):
                        span.set_attribute(
                            SpanAttributes.GIT_SOURCE_FUNCTION, source["git_source_function"]
                        )

                    # Set trace-level git context from client
                    from traceroot import get_client

                    client = get_client()
                    if client and client.git_repo:
                        span.set_attribute(SpanAttributes.GIT_REPO, client.git_repo)
                    if client and client.git_ref:
                        span.set_attribute(SpanAttributes.GIT_REF, client.git_ref)

                    try:
                        result = func(*args, **kwargs)
                        if capture_output and result is not None:
                            _set_output(span, result)
                        return result
                    except Exception as e:
                        span.set_status(Status(StatusCode.ERROR, str(e)))
                        span.record_exception(e)
                        raise

            return sync_wrapper  # type: ignore

    return decorator


def _set_span_attributes(
    span: trace.Span,
    span_kind: SpanKind,
    metadata: dict[str, Any] | None,
    tags: list[str] | None,
    args: tuple,
    kwargs: dict,
    func: Callable,
    capture_input: bool,
) -> None:
    """Set attributes on an OpenTelemetry span."""
    # Set span kind
    span.set_attribute(SpanAttributes.SPAN_TYPE, span_kind)

    # Set attributes from OpenInference context (session_id, user_id, etc.)
    try:
        for key, value in get_attributes_from_context():
            span.set_attribute(key, value)
    except Exception as e:
        logger.debug(f"Failed to get context attributes: {e}")

    # Set input if capturing
    if capture_input:
        try:
            input_data = _capture_args(args, kwargs, func)
            set_span_attribute(span, SpanAttributes.SPAN_INPUT, input_data)
        except Exception as e:
            logger.debug(f"Failed to capture input: {e}")

    # Set metadata
    if metadata:
        set_span_attribute(span, SpanAttributes.SPAN_METADATA, metadata)

    # Set tags
    if tags:
        span.set_attribute(SpanAttributes.SPAN_TAGS, tags)


def _set_output(span: trace.Span, result: Any) -> None:
    """Set output attribute on span."""
    try:
        output_data = serialize_value(result)
        set_span_attribute(span, SpanAttributes.SPAN_OUTPUT, output_data)
    except Exception as e:
        logger.debug(f"Failed to capture output: {e}")


def _capture_args(args: tuple, kwargs: dict, func: Callable) -> dict[str, Any]:
    """Capture function arguments as a dictionary."""
    sig = inspect.signature(func)
    bound = sig.bind(*args, **kwargs)
    bound.apply_defaults()
    # Filter out 'self' and 'cls' to avoid capturing instance/class references
    return {k: serialize_value(v) for k, v in bound.arguments.items() if k not in ("self", "cls")}
