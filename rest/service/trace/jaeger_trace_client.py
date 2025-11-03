import asyncio
import os
from datetime import datetime, timezone
from typing import Any, Optional

import requests

from rest.config.trace import Span, Trace
from rest.service.trace.trace_client import TraceClient
from rest.utils.datetime import ensure_utc_datetime
from rest.utils.trace import (
    accumulate_num_logs_to_traces,
    construct_traces,
    sort_spans_recursively,
)

PAGE_SIZE = 50  # Number of traces to return per page and fetch per service


class JaegerTraceClient(TraceClient):
    """Client for querying traces from Jaeger."""

    def __init__(
        self,
        jaeger_url: str | None = None,
    ):
        """Initialize the Jaeger trace client.

        Args:
            jaeger_url (str | None): Jaeger base URL. If None,
                uses JAEGER_URL env var or defaults to localhost.
        """
        if jaeger_url is None:
            jaeger_url = os.getenv("JAEGER_URL", "http://localhost:16686")

        api_url = f"{jaeger_url}/api"
        self.traces_url = f"{api_url}/traces"
        self.services_url = f"{api_url}/services"

    async def get_trace_by_id(
        self,
        trace_id: str,
        categories: list[str] | None = None,
        values: list[str] | None = None,
        operations: list[str] | None = None,
    ) -> Trace | None:
        """Get a single trace by ID from Jaeger.

        Args:
            trace_id: The trace ID to fetch
            categories: Not used for Jaeger (kept for interface consistency)
            values: Not used for Jaeger (kept for interface consistency)
            operations: Not used for Jaeger (kept for interface consistency)

        Returns:
            Trace object if found, None otherwise
        """
        try:
            # Jaeger API endpoint for getting trace by ID
            url = f"{self.traces_url}/{trace_id}"
            response = await self._make_request(url)

            if response and "data" in response:
                # Response contains a list of traces (should be just one)
                traces_data = response["data"]
                if traces_data and len(traces_data) > 0:
                    # Convert the first (and should be only) trace
                    trace = await self._convert_jaeger_trace_to_trace(traces_data[0])
                    return trace

            return None
        except Exception as e:
            print(f"Error getting trace by ID {trace_id}: {e}")
            return None

    async def get_recent_traces(
        self,
        start_time: datetime,
        end_time: datetime,
        log_group_name: str,
        service_name_values: list[str] | None = None,
        service_name_operations: list[str] | None = None,
        service_environment_values: list[str] | None = None,
        service_environment_operations: list[str] | None = None,
        categories: list[str] | None = None,
        values: list[str] | None = None,
        operations: list[str] | None = None,
        pagination_state: dict | None = None,
    ) -> tuple[list[Trace],
               dict | None]:
        """Get recent traces from Jaeger.

        Args:
            start_time (datetime): Start time of the trace
            end_time (datetime): End time of the trace
            log_group_name (str): The log group name
            service_name_values (list[str], optional): Filter values for
                service names if provided
            service_name_operations (list[str], optional): Filter operations
                for service names if provided
            service_environment_values (list[str], optional): Filter values for
                service environments if provided
            service_environment_operations (list[str], optional): Filter
                operations for service environments if provided
            categories (list[str], optional): Filter by categories
                if provided (service names are now included in categories)
            values (list[str], optional): Filter by values if provided
            operations (list[str], optional): Filter operations
                for values if provided

        Returns:
            tuple[list[Trace], dict | None]: Tuple of (traces, next_pagination_state)
        """
        # Ensure UTC time is used for consistent API queries
        end_time = ensure_utc_datetime(end_time)
        start_time = ensure_utc_datetime(start_time)

        # Convert to microseconds for Jaeger API
        start_time_us = int(start_time.timestamp() * 1_000_000)

        # Determine which services to query
        if categories:
            # Use the provided categories which now include service names
            services = categories
        else:
            # Get available services if categories are not provided
            current_time = datetime.now(timezone.utc)
            time_window_seconds = int((current_time - start_time).total_seconds())
            services = await self._get_services(lookback_seconds=time_window_seconds)
            if not services:
                return ([], None)

        # Remove jaeger service from list of services
        if "jaeger" in services:
            services.remove("jaeger")

        # Parse pagination state to get the last trace's start time
        # Use this as the new end_time boundary for the next query
        if pagination_state and "last_trace_start_time" in pagination_state:
            # Use the last trace's start time - 1 microsecond as the new end boundary
            # This ensures we don't get duplicate traces with the same timestamp
            end_time_us = pagination_state.get("last_trace_start_time") - 1
        else:
            # First request - no pagination
            end_time_us = int(end_time.timestamp() * 1_000_000)

        # Fetch traces from each service (no offset needed with time-based pagination)
        # Track which service each trace came from
        traces_with_service: list[tuple[Trace, str]] = []

        for service in services:
            curr_traces = await self._get_traces(
                service_name=service,
                start_time=start_time_us,
                end_time=end_time_us,
                limit=PAGE_SIZE,
                offset=0,  # Always use offset=0 since we're using time boundaries
            )

            if curr_traces:
                # Convert Jaeger traces to our Trace model
                for trace_data in curr_traces:
                    trace = await self._convert_jaeger_trace_to_trace(trace_data)
                    if trace:
                        # Store trace with its source service
                        traces_with_service.append((trace, service))

        if len(traces_with_service) == 0:
            return ([], None)

        # Sort traces by start_time in descending order (newest first)
        traces_with_service.sort(key=lambda x: x[0].start_time, reverse=True)

        # Take PAGE_SIZE + 1 traces to determine if there are more
        page_with_service = traces_with_service[:PAGE_SIZE + 1]

        # Check if there are more traces beyond this page
        has_more = len(page_with_service) > PAGE_SIZE

        if has_more:
            # Trim to PAGE_SIZE
            page_with_service = page_with_service[:PAGE_SIZE]

        # Extract just the traces (without service info) for return
        page_traces = [trace for trace, _ in page_with_service]

        # Use time-based pagination: store the last trace's start_time as the boundary
        # Next query will use (last_trace_start_time - 1μs) as
        # end_time to avoid duplicates
        if has_more:
            # Get the last (oldest) trace's start_time in microseconds
            last_trace_start_time_us = int(page_traces[-1].start_time * 1_000_000)

            next_pagination_state = {"last_trace_start_time": last_trace_start_time_us}
        else:
            # No more traces
            next_pagination_state = None

        return (page_traces, next_pagination_state)

    async def get_trace_with_spans_by_ids(
        self,
        trace_ids: list[str],
        categories: list[str] | None = None,
        values: list[str] | None = None,
        operations: list[str] | None = None,
    ) -> dict[str,
              list[Span]]:
        """Get trace with spans by trace IDs.

        Args:
            trace_ids (list[str]): List of trace IDs to fetch
            categories (list[str], optional): Filter by categories if provided
            values (list[str], optional): Filter by values if provided
            operations (list[str], optional): Filter by operations
                for values if provided

        Returns:
            dict[str, list[Span]]: Dictionary of trace_id and list of spans.

        Note:
            This method signature is provided for interface consistency.
            Implementation not provided as requested.
        """
        # Implementation not provided as requested
        return {}

    async def _get_services(
        self,
        lookback_seconds: int = 10 * 60,
    ) -> list[str]:
        """Get list of available services from Jaeger."""
        try:
            params = {"lookback": f"{lookback_seconds}s"}

            response = await self._make_request(f"{self.services_url}", params=params)

            if response and "data" in response:
                return response["data"]
            return []
        except Exception as e:
            print(f"Error getting services: {e}")
            return []

    async def _get_traces(
        self,
        service_name: str,
        start_time: int,
        end_time: int,
        limit: int,
        offset: int = 0,
    ) -> list[dict[str,
                   Any]]:
        """Get traces from Jaeger API.

        Args:
            service_name: Name of the service to query
            start_time: Start time in microseconds
            end_time: End time in microseconds
            limit: Maximum number of traces to fetch
            offset: Number of traces to skip (for pagination)

        Returns:
            List of trace data dictionaries from Jaeger
        """
        try:
            params = {
                "service": service_name,
                "start": start_time,
                "end": end_time,
                "limit": limit,
            }

            # Add offset parameter if non-zero
            if offset > 0:
                params["offset"] = offset

            response = await self._make_request(f"{self.traces_url}", params=params)

            if response and "data" in response:
                return response["data"]
            return []
        except Exception as e:
            print(f"Error getting traces: {e}")
            return []

    async def _convert_jaeger_trace_to_trace(
        self,
        trace_data: dict[str,
                         Any],
    ) -> Optional[Trace]:
        """Convert Jaeger trace data to our Trace model."""
        try:
            # Extract basic trace information
            trace_id = trace_data.get("traceID")
            if not trace_id:
                return None

            spans_data = trace_data.get("spans", [])
            if not spans_data:
                return None

            # Convert spans to individual Span objects (without hierarchy)
            spans_dict: dict[str, Span] = {}
            for span_data in spans_data:
                span: Span | None = self._convert_jaeger_span_to_span(span_data)
                if span:
                    spans_dict[span.id] = span

            if not spans_dict:
                return None

            # Build parent-child relationships using parentSpanID
            root_spans: list[Span] = self._build_span_hierarchy(spans_data, spans_dict)

            # Calculate trace start time, end time, and duration
            start_times = [span.start_time for span in spans_dict.values()]
            end_times = [span.end_time for span in spans_dict.values()]

            trace_start_time = min(start_times)
            trace_end_time = max(end_times)
            trace_duration = trace_end_time - trace_start_time

            # Extract service name from first span
            service_name: str | None = None
            service_environment: str | None = None
            if spans_data:
                # Try to get service name from span tags or process
                first_span_data = spans_data[0]
                for tag in first_span_data.get("tags", []):
                    if tag.get("key") == "service_name":
                        service_name = tag.get("value")
                    if tag.get("key") == "service_environment":
                        service_environment = tag.get("value")

            # Create trace using construct_traces utility
            traces = construct_traces(
                service_names=[service_name],
                service_environments=[service_environment],
                trace_ids=[trace_id],
                start_times=[trace_start_time],
                durations=[trace_duration],
            )

            if traces:
                trace = traces[0]
                trace.spans = root_spans
                sort_spans_recursively(trace.spans)
                accumulate_num_logs_to_traces([trace])
                return trace

            return None
        except Exception as e:
            print(f"Error converting Jaeger trace: {e}")
            return None

    def _build_span_hierarchy(
        self,
        spans_data: list[dict[str,
                              Any]],
        spans_dict: dict[str,
                         Span],
    ) -> list[Span]:
        """Build hierarchical span structure from flat span data.

        Jaeger provides spans in a flat structure with parentSpanID references.
        This method constructs the proper parent-child relationships by:
        1. Creating a mapping of span_id to parent_span_id
        2. Organizing spans into their parent's spans list
        3. Returning only root spans (spans with no parent)

        Args:
            spans_data: Raw span data from Jaeger API
            spans_dict: Dictionary mapping span IDs to Span objects

        Returns:
            List of root spans with properly nested child spans
        """
        # Create a mapping of span_id to parent_span_id
        parent_map: dict[str, str] = {}
        for span_data in spans_data:
            span_id = span_data.get("spanID")
            references = span_data.get("references", [])

            # Look for CHILD_OF references to find parent span
            for ref in references:
                if ref.get("refType") == "CHILD_OF":
                    parent_span_id = ref.get("spanID")
                    if span_id and parent_span_id:
                        parent_map[span_id] = parent_span_id
                        break  # Use first CHILD_OF reference

        # Build the hierarchy
        root_spans: list[Span] = []
        for span_id, span in spans_dict.items():
            if span_id in parent_map:
                # This span has a parent
                parent_id = parent_map[span_id]
                if parent_id in spans_dict:
                    # Add this span as a child of its parent
                    spans_dict[parent_id].spans.append(span)
                else:
                    # Parent not found, treat as root
                    root_spans.append(span)
            else:
                # This span has no parent, it's a root span
                root_spans.append(span)

        return root_spans

    def _convert_jaeger_span_to_span(
        self,
        span_data: dict[str,
                        Any],
    ) -> Span | None:
        """Convert Jaeger span data to our Span model."""
        try:
            span_id = span_data.get("spanID")
            operation_name = span_data.get("operationName", "")

            num_debug_logs: int = 0
            num_info_logs: int = 0
            num_warning_logs: int = 0
            num_error_logs: int = 0
            num_critical_logs: int = 0
            telemetry_sdk_language: str | None = None

            for tag in span_data.get("tags", []):
                if tag.get("key") == "num_debug_logs":
                    num_debug_logs = int(tag.get("value"))
                if tag.get("key") == "num_info_logs":
                    num_info_logs = int(tag.get("value"))
                if tag.get("key") == "num_warning_logs":
                    num_warning_logs = int(tag.get("value"))
                if tag.get("key") == "num_error_logs":
                    num_error_logs = int(tag.get("value"))
                if tag.get("key") == "num_critical_logs":
                    num_critical_logs = int(tag.get("value"))
                if tag.get("key") == "telemetry.sdk.language":
                    telemetry_sdk_language = tag.get("value")

            # Convert microseconds to seconds (float)
            start_time = span_data.get("startTime", 0) / 1_000_000.0
            duration_us = span_data.get("duration", 0)
            duration = duration_us / 1_000_000.0
            end_time = start_time + duration

            span = Span(
                id=span_id,
                parent_id=None,
                name=operation_name,
                start_time=start_time,
                end_time=end_time,
                duration=duration,
                num_debug_logs=num_debug_logs,
                num_info_logs=num_info_logs,
                num_warning_logs=num_warning_logs,
                num_error_logs=num_error_logs,
                num_critical_logs=num_critical_logs,
                telemetry_sdk_language=telemetry_sdk_language,
                spans=[],  # Will be populated by _build_span_hierarchy
            )

            return span
        except Exception as e:
            print(f"Error converting Jaeger span: {e}")
            return None

    async def _make_request(self,
                            url: str,
                            params: Optional[dict] = None) -> Optional[dict[str,
                                                                            Any]]:
        """Make HTTP request to Jaeger API."""
        loop = asyncio.get_event_loop()

        def _request():
            try:
                response = requests.get(url, params=params)
                if response.ok:
                    # Check if response has content before trying to parse JSON
                    if response.content.strip():
                        return response.json()
                    else:
                        print(f"Empty response from {url}")
                        return None
                else:
                    print(f"Error: {response.status_code} - {response.text}")
                    return None
            except requests.exceptions.JSONDecodeError as e:
                print(f"JSON decode error for {url}: {e}")
                return None
            except Exception as e:
                print(f"Request error for {url}: {e}")
                return None

        return await loop.run_in_executor(None, _request)
