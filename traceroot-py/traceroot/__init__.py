"""Traceroot Python SDK - Observability for LLM applications.

Basic Usage:
    import traceroot
    from traceroot import observe

    # Initialize (reads TRACEROOT_API_KEY from env)
    traceroot.initialize()

    # Use @observe decorator to trace functions
    @observe(name="my_agent", type="agent")
    def my_agent(query: str) -> str:
        return process(query)

    # Use OpenInference for auto-instrumentation
    from openinference.instrumentation.openai import OpenAIInstrumentor
    OpenAIInstrumentor().instrument()

Session Management:
    from openinference.instrumentation import using_attributes

    with using_attributes(session_id="conv-123", user_id="user-456"):
        # All traces in this block get session_id and user_id
        response = client.chat.completions.create(...)
"""

from traceroot.client import TracerootClient
from traceroot.context import get_current_trace_id, get_current_span_id
from traceroot.decorators import observe
from traceroot.update import update_current_span, update_current_trace

# Re-export using_attributes from OpenInference for convenience
from openinference.instrumentation import using_attributes

__version__ = "0.1.0"

# =============================================================================
# Global Singleton Client
# =============================================================================
_client: TracerootClient | None = None


def initialize(
    api_key: str | None = None,
    host_url: str | None = None,
    flush_interval: float = 5.0,
    batch_size: int = 100,
    enabled: bool = True,
) -> TracerootClient:
    """Initialize the global Traceroot client.

    Call this once at application startup before using any tracing.

    Args:
        api_key: API key. Defaults to TRACEROOT_API_KEY env var.
        host_url: API host URL. Defaults to TRACEROOT_HOST_URL env var.
        flush_interval: Seconds between automatic flushes. Default: 5.0
        batch_size: Max batch size before flush. Default: 100
        enabled: Whether tracing is enabled. Default: True

    Returns:
        The TracerootClient instance.

    Example:
        import traceroot
        traceroot.initialize()  # Reads from env vars
    """
    global _client
    _client = TracerootClient(
        api_key=api_key,
        host_url=host_url,
        flush_interval=flush_interval,
        batch_size=batch_size,
        enabled=enabled,
    )
    return _client


def get_client() -> TracerootClient | None:
    """Get the global Traceroot client (internal use)."""
    return _client


def flush() -> None:
    """Flush all pending traces."""
    if _client:
        _client.flush()


def shutdown() -> None:
    """Shutdown the SDK gracefully."""
    if _client:
        _client.shutdown()


__all__ = [
    # Core
    "initialize",
    "flush",
    "shutdown",
    "observe",
    "TracerootClient",
    # Context utilities
    "get_current_trace_id",
    "get_current_span_id",
    # Update functions
    "update_current_span",
    "update_current_trace",
    # OpenInference (re-exported for convenience)
    "using_attributes",
]
