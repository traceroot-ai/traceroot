"""Span processor for Traceroot OpenTelemetry integration.

This module defines the TracerootSpanProcessor class, which extends OpenTelemetry's
BatchSpanProcessor with Traceroot-specific configuration.
"""

import os

from opentelemetry.exporter.otlp.proto.http.trace_exporter import (
    Compression,
    OTLPSpanExporter,
)
from opentelemetry.sdk.trace.export import BatchSpanProcessor

from traceroot.constants import (
    DEFAULT_FLUSH_AT,
    DEFAULT_FLUSH_INTERVAL,
    SDK_NAME,
    SDK_VERSION,
)
from traceroot.env import TRACEROOT_FLUSH_AT, TRACEROOT_FLUSH_INTERVAL


class TracerootSpanProcessor(BatchSpanProcessor):
    """OpenTelemetry span processor that exports spans to Traceroot API.

    This processor extends OpenTelemetry's BatchSpanProcessor with Traceroot-specific
    configuration and defaults. It uses the standard OTLPSpanExporter to send
    OTLP-formatted trace data (protobuf) to the Traceroot backend.

    The API layer handles protobuf → JSON conversion before storing to S3.

    Features:
    - Configurable batch size and flush interval via constructor or env vars
    - Automatic batching and periodic flushing
    - Graceful shutdown with final flush
    - OTLP HTTP-based span export with gzip compression
    """

    def __init__(
        self,
        *,
        api_key: str,
        host_url: str,
        flush_at: int | None = None,
        flush_interval: float | None = None,
    ):
        """Initialize the span processor.

        Args:
            api_key: Traceroot API key for authentication.
            host_url: Traceroot API host URL.
            flush_at: Max batch size before flush. Falls back to TRACEROOT_FLUSH_AT
                env var, then DEFAULT_FLUSH_AT.
            flush_interval: Seconds between automatic flushes. Falls back to
                TRACEROOT_FLUSH_INTERVAL env var, then DEFAULT_FLUSH_INTERVAL.
        """
        # Resolve flush_at with env var fallback
        if flush_at is None:
            env_flush_at = os.environ.get(TRACEROOT_FLUSH_AT)
            flush_at = int(env_flush_at) if env_flush_at else DEFAULT_FLUSH_AT

        # Resolve flush_interval with env var fallback
        if flush_interval is None:
            env_flush_interval = os.environ.get(TRACEROOT_FLUSH_INTERVAL)
            flush_interval = (
                float(env_flush_interval)
                if env_flush_interval
                else DEFAULT_FLUSH_INTERVAL
            )

        # Build endpoint URL
        endpoint = f"{host_url.rstrip('/')}/api/v1/public/traces"

        # Create the standard OTLP exporter (protobuf format)
        exporter = OTLPSpanExporter(
            endpoint=endpoint,
            headers={
                "Authorization": f"Bearer {api_key}",
                "x-traceroot-sdk-name": SDK_NAME,
                "x-traceroot-sdk-version": SDK_VERSION,
            },
            compression=Compression.Gzip,
        )

        # Initialize parent BatchSpanProcessor
        super().__init__(
            span_exporter=exporter,
            max_export_batch_size=flush_at,
            schedule_delay_millis=int(flush_interval * 1000),
        )

        self._flush_at = flush_at
        self._flush_interval = flush_interval

    @property
    def flush_at(self) -> int:
        """Get the configured batch size."""
        return self._flush_at

    @property
    def flush_interval(self) -> float:
        """Get the configured flush interval in seconds."""
        return self._flush_interval
