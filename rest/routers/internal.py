import gzip
import json
import logging
from collections import defaultdict
from datetime import datetime

from fastapi import APIRouter, Request
from google.protobuf import json_format
from opentelemetry.proto.collector.trace.v1.trace_service_pb2 import (
    ExportTraceServiceRequest,
)

from rest.utils.traces_and_logs_tracking import get_traces_and_logs_tracker

try:
    from rest.dao.ee.mongodb_dao import TraceRootMongoDBClient
except ImportError:
    from rest.dao.mongodb_dao import TraceRootMongoDBClient

logger = logging.getLogger(__name__)

# In-memory usage buffer: {user_hash: {"traces": count, "logs": count}}
usage_buffer: dict[str, dict[str, int]] = defaultdict(lambda: {"traces": 0, "logs": 0})
last_flush_time = datetime.now()
FLUSH_INTERVAL_SECONDS = 10


class InternalRouter:
    """Internal router for OTLP usage tracking."""

    def __init__(self):
        self.router = APIRouter()
        self.db_client = TraceRootMongoDBClient()
        self._setup_routes()

    def _setup_routes(self):
        """Set up internal API routes."""
        self.router.post("/v1/traces")(self.receive_traces)

    async def receive_traces(self, request: Request) -> dict[str, str]:
        """Receive OTLP traces from collector and track usage.

        Args:
            request: FastAPI request with OTLP protobuf payload

        Returns:
            Status response
        """
        try:
            # Get the request body
            body = await request.body()

            # Check Content-Type and Content-Encoding headers
            content_type = request.headers.get("content-type", "").lower()
            content_encoding = request.headers.get("content-encoding", "").lower()

            # Decompress if needed
            if content_encoding == "gzip":
                body = gzip.decompress(body)

            # Parse based on content type
            export_request = ExportTraceServiceRequest()

            if "application/json" in content_type:
                # Parse JSON format
                json_data = json.loads(body)
                json_format.ParseDict(json_data, export_request)
            else:
                # Parse as binary protobuf (default)
                export_request.ParseFromString(body)

            # Extract user hash and count spans + logs
            for resource_span in export_request.resource_spans:
                # Count spans and extract log counts from span attributes
                # user_sub is in span attributes, not resource attributes!
                for scope_span in resource_span.scope_spans:

                    for span in scope_span.spans:
                        # Extract hash and log counts from THIS span's attributes
                        user_hash = None
                        span_log_count = 0

                        for attr in span.attributes:
                            if attr.key == "hash":
                                user_hash = attr.value.string_value
                            elif attr.key in [
                                "num_debug_logs",
                                "num_info_logs",
                                "num_warning_logs",
                                "num_error_logs",
                                "num_critical_logs"
                            ]:
                                span_log_count += attr.value.int_value

                        # Only count if we found a hash
                        if user_hash:
                            usage_buffer[user_hash]["traces"] += 1
                            usage_buffer[user_hash]["logs"] += span_log_count

            # Flush if needed
            await self._maybe_flush_usage()

            return {"status": "ok"}

        except Exception as e:
            logger.error(f"Error receiving OTLP traces: {e}", exc_info=True)
            return {"status": "error", "message": str(e)}

    async def _maybe_flush_usage(self) -> None:
        """Flush usage buffer to Autumn if interval has passed."""
        global last_flush_time

        now = datetime.now()
        time_since_flush = (now - last_flush_time).total_seconds()

        if time_since_flush < FLUSH_INTERVAL_SECONDS:
            return  # Not time to flush yet

        # Update flush time
        last_flush_time = now

        # Grab current buffer and clear it
        if not usage_buffer:
            return  # Nothing to flush

        current_usage = dict(usage_buffer)
        usage_buffer.clear()

        # Send to Autumn
        tracker = get_traces_and_logs_tracker()

        for user_hash, counts in current_usage.items():
            try:
                # Look up the original user_sub from the hash
                user_sub = await self.db_client.get_user_sub_by_hash(user_hash)

                if not user_sub:
                    logger.warning(
                        f"Could not find user_sub for hash {user_hash[:16]}..., skipping"
                    )
                    continue

                await tracker.track_traces_and_logs(
                    customer_id=user_sub,
                    trace_count=counts["traces"],
                    log_count=counts["logs"],
                )
            except Exception as e:
                logger.error(
                    f"Failed to track usage for {user_hash[:16]}...: {e}",
                    exc_info=True
                )
