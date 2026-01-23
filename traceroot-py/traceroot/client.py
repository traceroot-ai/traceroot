"""Traceroot client."""

import atexit
import logging
import os

from opentelemetry import trace
from opentelemetry.sdk.trace import TracerProvider

from traceroot.constants import (
    DEFAULT_FLUSH_AT,
    DEFAULT_FLUSH_INTERVAL,
    DEFAULT_HOST_URL,
)
from traceroot.env import (
    TRACEROOT_API_KEY,
    TRACEROOT_ENABLED,
    TRACEROOT_FLUSH_AT,
    TRACEROOT_FLUSH_INTERVAL,
    TRACEROOT_HOST_URL,
)
from traceroot.transport.span_processor import TracerootSpanProcessor

logger = logging.getLogger(__name__)


class TracerootClient:
    """Main client for sending traces to Traceroot.

    The client initializes an OpenTelemetry TracerProvider with a span processor
    that exports OTLP-formatted trace data to the Traceroot backend.
    """

    def __init__(
        self,
        api_key: str | None = None,
        host_url: str | None = None,
        flush_interval: float | None = None,
        batch_size: int | None = None,
        enabled: bool | None = None,
    ):
        """Initialize the Traceroot client.

        Args:
            api_key: API key for authentication. Falls back to TRACEROOT_API_KEY env var.
            host_url: API host URL. Falls back to TRACEROOT_HOST_URL env var.
            flush_interval: Seconds between automatic flushes. Falls back to
                TRACEROOT_FLUSH_INTERVAL env var, then 5.0.
            batch_size: Maximum items per batch before flush. Falls back to
                TRACEROOT_FLUSH_AT env var, then 100.
            enabled: Whether tracing is enabled. Falls back to TRACEROOT_ENABLED env var.
        """
        # Resolve config with env var fallbacks
        self.api_key = api_key or os.environ.get(TRACEROOT_API_KEY, "")
        self.host_url = host_url or os.environ.get(TRACEROOT_HOST_URL, DEFAULT_HOST_URL)

        if flush_interval is None:
            env_interval = os.environ.get(TRACEROOT_FLUSH_INTERVAL)
            flush_interval = float(env_interval) if env_interval else DEFAULT_FLUSH_INTERVAL
        self.flush_interval = flush_interval

        if batch_size is None:
            env_batch = os.environ.get(TRACEROOT_FLUSH_AT)
            batch_size = int(env_batch) if env_batch else DEFAULT_FLUSH_AT
        self.batch_size = batch_size

        if enabled is None:
            env_enabled = os.environ.get(TRACEROOT_ENABLED, "").lower()
            enabled = env_enabled not in ("false", "0", "no", "off") if env_enabled else True

        self._enabled = enabled and bool(self.api_key)
        self._span_processor: TracerootSpanProcessor | None = None
        self._provider: TracerProvider | None = None
        self._initialized = False

        if self._enabled:
            self._initialize()

    def _initialize(self) -> None:
        """Initialize TracerProvider with span processor."""
        if self._initialized:
            return

        # Create span processor
        self._span_processor = TracerootSpanProcessor(
            api_key=self.api_key,
            host_url=self.host_url,
            flush_at=self.batch_size,
            flush_interval=self.flush_interval,
        )

        # Create and configure TracerProvider
        self._provider = TracerProvider()
        self._provider.add_span_processor(self._span_processor)

        # Set as global provider so @observe decorator uses it
        trace.set_tracer_provider(self._provider)

        # Register shutdown handler
        atexit.register(self.shutdown)

        self._initialized = True
        logger.debug("Traceroot client initialized with TracerProvider")

    @property
    def enabled(self) -> bool:
        """Check if tracing is enabled."""
        return self._enabled

    @property
    def span_processor(self) -> TracerootSpanProcessor | None:
        """Get the span processor for OTel integration."""
        return self._span_processor

    def flush(self) -> None:
        """Flush all pending traces."""
        if self._span_processor:
            self._span_processor.force_flush()

    def shutdown(self) -> None:
        """Shutdown the client gracefully."""
        if self._span_processor:
            self._span_processor.shutdown()
            self._span_processor = None

        self._provider = None
        self._initialized = False
        logger.debug("Traceroot client shutdown")
