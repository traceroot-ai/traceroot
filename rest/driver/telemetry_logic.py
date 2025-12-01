"""Telemetry driver - Business logic for trace and log operations.

This driver orchestrates telemetry operations, coordinating between:
- Database clients (MongoDB, SQLite)
- Observability providers (AWS, Tencent, Jaeger)
- Cache services
- Backend trace query services
"""

import logging
import os
from datetime import datetime, timezone
from typing import Any

from fastapi import Request

from rest.cache import Cache
from rest.config import (
    GetLogByTraceIdResponse,
    ListTraceRequest,
    ListTraceResponse,
    Trace,
    TraceLogs,
)
from rest.dao.sqlite_dao import TraceRootSQLiteClient
from rest.service.provider import ObservabilityProvider
from rest.rest_types import Operation
from rest.utils.pagination import PaginationHelper
from rest.utils.provider import get_observe_provider
from rest.utils.trace_cache import TraceCacheHelper
from rest.utils.trace_query import (
    FilterCategories,
    TraceQueryHelper,
    separate_filter_categories,
)

try:
    from rest.dao.ee.mongodb_dao import TraceRootMongoDBClient
except ImportError:
    from rest.dao.mongodb_dao import TraceRootMongoDBClient

try:
    from rest.utils.ee.auth import hash_user_sub
except ImportError:
    from rest.utils.auth import hash_user_sub


class TelemetryLogic:
    """Business logic for telemetry (trace and log) operations."""

    def __init__(self, local_mode: bool):
        """Initialize telemetry driver.

        Args:
            local_mode: Whether running in local mode (SQLite + Jaeger) or cloud mode
        """
        self.local_mode = local_mode
        self.logger = logging.getLogger(__name__)

        # Choose client based on local mode
        if self.local_mode:
            self.db_client = TraceRootSQLiteClient()
        else:
            self.db_client = TraceRootMongoDBClient()

        # Create default observability provider
        if self.local_mode:
            # Get Jaeger endpoint from env or use localhost default
            jaeger_url = os.getenv("JAEGER_ENDPOINT", "http://localhost:16686")
            self.default_observe_provider = ObservabilityProvider.create_jaeger_provider(
                jaeger_url=jaeger_url
            )
        else:
            self.default_observe_provider = ObservabilityProvider.create_aws_provider()

        # Initialize cache
        self.cache = Cache()
        self.cache_helper = TraceCacheHelper(self.cache)

    async def list_traces(
        self,
        request: Request,
        req_data: ListTraceRequest,
        user_sub: str,
    ) -> dict[str,
              Any]:
        """Business logic for listing traces.

        Handles three main use cases:
        1. Direct trace ID lookup - returns single trace (optimized path)
        2. Log search filtering - searches logs then fetches matching traces
        3. Normal trace filtering - fetches traces with optional filters

        Args:
            request: FastAPI request object
            req_data: Parsed request data
            user_sub: User's subject ID for log grouping

        Returns:
            Dictionary containing list of trace data

        Raises:
            ValueError: If request parameters are invalid
        """
        # 1. Get log group name from user credentials
        log_group_name = hash_user_sub(user_sub)

        # 2. Separate filter categories (business rules)
        filter_cats = separate_filter_categories(
            req_data.categories.copy(),
            req_data.values.copy(),
            req_data.operations.copy(),
        )

        # 3. Handle direct trace ID lookup (early return for optimization)
        if req_data.trace_id:
            return await self._get_single_trace_by_id(
                request,
                req_data.trace_id,
                filter_cats
            )

        # 4. Decode pagination token
        pagination_state = PaginationHelper.decode(req_data.pagination_token)

        # 5. Build cache key and check cache
        cache_key = self.cache_helper.build_cache_key(
            req_data.start_time,
            req_data.end_time,
            req_data.categories,
            req_data.values,
            req_data.operations,
            log_group_name,
            req_data.pagination_token,
        )

        cached_result = await self.cache_helper.get_traces(cache_key)
        if cached_result:
            traces, next_state = cached_result
            next_token = PaginationHelper.encode(next_state)
            return TraceQueryHelper.format_response(traces, next_token)

        # 6. Fetch traces based on filter type
        observe_provider = await get_observe_provider(
            request=request,
            db_client=self.db_client,
            local_mode=self.local_mode,
            default_provider=self.default_observe_provider,
        )

        if filter_cats.has_log_search:
            # Log search path: Search logs first, then fetch matching traces
            log_search_values = filter_cats.log_search_values
            trace_provider = request.query_params.get("trace_provider", "aws")

            # Delegate to private method for log search orchestration
            traces, next_state = await self._get_traces_by_log_search_paginated(
                observe_provider=observe_provider,
                start_time=req_data.start_time,
                end_time=req_data.end_time,
                log_group_name=log_group_name,
                log_search_values=log_search_values,
                categories=filter_cats.remaining_categories,
                values=filter_cats.remaining_values,
                operations=filter_cats.remaining_operations,
                pagination_state=pagination_state,
                trace_provider=trace_provider,
            )
        else:
            # Normal path: Fetch traces directly with filters
            traces, next_state = \
                await observe_provider.trace_client.get_recent_traces(
                    start_time=req_data.start_time,
                    end_time=req_data.end_time,
                    log_group_name=log_group_name,
                    service_name_values=filter_cats.service_name_values,
                    service_name_operations=filter_cats.service_name_operations,
                    service_environment_values=(
                        filter_cats.service_environment_values
                    ),
                    service_environment_operations=(
                        filter_cats.service_environment_operations
                    ),
                    categories=filter_cats.remaining_categories,
                    values=filter_cats.remaining_values,
                    operations=filter_cats.remaining_operations,
                    pagination_state=pagination_state,
                )

        # 7. Cache results and return
        await self.cache_helper.cache_traces(cache_key, traces, next_state)
        next_token = PaginationHelper.encode(next_state)
        return TraceQueryHelper.format_response(traces, next_token)

    async def get_logs_by_trace_id(
        self,
        request: Request,
        trace_id: str,
        start_time: datetime | None,
        end_time: datetime | None,
        user_sub: str,
    ) -> dict[str,
              Any]:
        """Business logic for getting logs by trace ID.

        Optimizes log queries by using trace timestamps when available.
        Handles special case of LimitExceeded traces.

        Args:
            request: FastAPI request object
            trace_id: Trace ID to fetch logs for
            start_time: Optional start time (if None, infer from trace)
            end_time: Optional end time (if None, infer from trace)
            user_sub: User's subject ID for log grouping

        Returns:
            Dictionary containing trace logs

        Raises:
            ValueError: If request parameters are invalid
        """
        log_group_name = hash_user_sub(user_sub)

        observe_provider = await get_observe_provider(
            request=request,
            db_client=self.db_client,
            local_mode=self.local_mode,
            default_provider=self.default_observe_provider,
        )

        # Optimization: If start_time/end_time not provided, fetch trace
        # to get timestamps which allows for much faster log queries
        log_start_time = start_time
        log_end_time = end_time

        if log_start_time is None or log_end_time is None:
            trace = await observe_provider.trace_client.get_trace_by_id(
                trace_id=trace_id,
                categories=None,
                values=None,
                operations=None,
            )
            if trace:
                # Check if this is a LimitExceeded trace
                if (
                    trace.service_name == "LimitExceeded" and trace.start_time == 0.0
                    and trace.end_time == 0.0
                ):
                    # For LimitExceeded traces, fetch timestamps from logs
                    try:
                        log_client = observe_provider.log_client
                        (
                            earliest,
                            latest,
                        ) = await log_client.get_log_timestamps_by_trace_id(
                            trace_id=trace_id,
                            log_group_name=log_group_name,
                            start_time=start_time,
                            end_time=end_time,
                        )
                        if earliest and latest:
                            log_start_time = earliest
                            log_end_time = latest
                    except Exception as e:
                        self.logger.error(
                            f"Failed to get log timestamps for "
                            f"LimitExceeded trace {trace_id}: {e}"
                        )
                else:
                    # Normal trace with valid timestamps
                    log_start_time = datetime.fromtimestamp(
                        trace.start_time,
                        tz=timezone.utc
                    )
                    log_end_time = datetime.fromtimestamp(trace.end_time, tz=timezone.utc)

        # Try to get cached logs
        log_cache_key = self.cache_helper.build_log_cache_key(
            trace_id,
            log_start_time,
            log_end_time,
            log_group_name
        )
        cached_logs: TraceLogs | None = await self.cache_helper.get_logs(log_cache_key)
        if cached_logs:
            resp = GetLogByTraceIdResponse(trace_id=trace_id, logs=cached_logs)
            return resp.model_dump()

        # Fetch logs from backend
        logs: TraceLogs = await observe_provider.log_client.get_logs_by_trace_id(
            trace_id=trace_id,
            start_time=log_start_time,
            end_time=log_end_time,
            log_group_name=log_group_name,
        )

        # Cache the logs for 10 minutes
        await self.cache_helper.cache_logs(log_cache_key, logs)

        resp = GetLogByTraceIdResponse(trace_id=trace_id, logs=logs)
        return resp.model_dump()

    async def _get_single_trace_by_id(
        self,
        request: Request,
        trace_id: str,
        filter_cats: FilterCategories,
    ) -> dict[str,
              Any]:
        """Fetch a single trace by ID directly.

        This is an optimized path when user requests a specific trace.

        Args:
            request: FastAPI request object
            trace_id: Trace ID to fetch
            filter_cats: Filter categories to apply

        Returns:
            ListTraceResponse dict
        """
        observe_provider = await get_observe_provider(
            request=request,
            db_client=self.db_client,
            local_mode=self.local_mode,
            default_provider=self.default_observe_provider,
        )

        trace = await observe_provider.trace_client.get_trace_by_id(
            trace_id=trace_id,
            categories=filter_cats.remaining_categories,
            values=filter_cats.remaining_values,
            operations=filter_cats.remaining_operations,
        )

        # If trace not found, return empty list
        if trace is None:
            resp = ListTraceResponse(traces=[])
            return resp.model_dump()

        resp = ListTraceResponse(traces=[trace])
        return resp.model_dump()

    async def _get_traces_by_log_search_paginated(
        self,
        observe_provider: ObservabilityProvider,
        start_time: datetime,
        end_time: datetime,
        log_group_name: str,
        log_search_values: list[str],
        categories: list[str] | None = None,
        values: list[str] | None = None,
        operations: list[Operation] | None = None,
        pagination_state: dict | None = None,
        page_size: int = 50,
        trace_provider: str = 'aws',
    ) -> tuple[list[Trace],
               dict | None]:
        """Get traces matching log search criteria with pagination support.

        Private method - orchestrates cache, log search, and trace fetching.

        This method implements pagination by:
        1. First request: Query CloudWatch for ALL trace IDs and cache them
        2. Subsequent requests: Use cached trace IDs
        3. Fetch only a batch of traces per request

        ORDERING STRATEGY:
        Trace IDs are returned from CloudWatch sorted by LOG timestamp (newest first),
        NOT by span start_time. This is a deliberate trade-off:
        - Pro: Fast and cheap (single CloudWatch query, no X-Ray calls)
        - Con: Log timestamp ≠ span start time (usually close, but can differ)
        - Result: 99% of traces appear in chronological order, occasional outliers

        CRITICAL: The trace ID list from CloudWatch MUST preserve order for pagination
        to work correctly. See aws_log_client.py for implementation details.

        Args:
            observe_provider: Observability provider instance
            start_time: Start time for log query
            end_time: End time for log query
            log_group_name: Log group name
            log_search_values: List of search terms to look for in logs
            categories: Filter by categories if provided
            values: Filter by values if provided
            operations: Filter by operations if provided
            pagination_state: State from previous request (contains cache_key and offset)
            page_size: Number of traces to return per page
            trace_provider: Trace provider type (aws, tencent, jaeger)

        Returns:
            Tuple of (traces, next_pagination_state)
        """
        if not log_search_values:
            return [], None

        search_term = log_search_values[0]

        try:
            # Generate cache key for this specific log search
            import hashlib
            cache_params = (
                f"{start_time.isoformat()}_{end_time.isoformat()}"
                f"_{log_group_name}_{search_term}"
            )
            cache_key = (
                f"log_search_trace_ids:"
                f"{hashlib.md5(cache_params.encode()).hexdigest()}"
            )

            # Determine offset and get trace metadata from log search
            if PaginationHelper.is_log_search(pagination_state):
                offset = pagination_state.get('offset', 0)
                # Try to get cached trace metadata
                cached_metadata = await self.cache_helper.get_trace_metadata(cache_key)
                if cached_metadata:
                    trace_id_to_metadata = cached_metadata
                else:
                    # Cache expired, need to re-query CloudWatch
                    trace_id_to_metadata = \
                        await observe_provider.log_client.get_trace_metadata_from_logs(
                            start_time=start_time,
                            end_time=end_time,
                            log_group_name=log_group_name,
                            search_term=search_term
                        )
                    # Re-cache for 10 minutes
                    await self.cache_helper.cache_trace_metadata(
                        cache_key,
                        trace_id_to_metadata
                    )
            else:
                # First request - query CloudWatch logs
                offset = 0
                # Get all matching trace metadata from CloudWatch logs
                trace_id_to_metadata = (
                    await observe_provider.log_client.get_trace_metadata_from_logs(
                        start_time=start_time,
                        end_time=end_time,
                        log_group_name=log_group_name,
                        search_term=search_term
                    )
                )
                # Cache the trace metadata for 10 minutes
                await self.cache_helper.cache_trace_metadata(
                    cache_key,
                    trace_id_to_metadata
                )

            if not trace_id_to_metadata:
                return [], None

            # Fetch batch of traces with categorical filtering
            traces, final_offset = await self._fetch_trace_batch_with_filters(
                observe_provider=observe_provider,
                trace_id_to_metadata=trace_id_to_metadata,
                offset=offset,
                page_size=page_size,
                categories=categories,
                values=values,
                operations=operations,
            )

            self.logger.info(f"Successfully fetched {len(traces)} traces from log search")

            # Sort by start_time descending (newest first)
            traces.sort(key=lambda t: t.start_time, reverse=True)

            # Prepare next pagination state
            next_offset = final_offset + page_size
            self.logger.debug(
                f"Calculating next state: next_offset={next_offset}, "
                f"total_traces={len(trace_id_to_metadata)}"
            )
            if next_offset < len(trace_id_to_metadata):
                next_state = PaginationHelper.create_log_search_state(
                    offset=next_offset,
                    search_term=search_term,
                    cache_key=cache_key,
                    provider=trace_provider
                )
            else:
                next_state = None

            return traces, next_state

        except Exception as e:
            self.logger.error(f"Failed to get traces by log search: {e}")
            return [], None

    async def _fetch_trace_batch_with_filters(
        self,
        observe_provider: ObservabilityProvider,
        trace_id_to_metadata: dict[str,
                                   dict],
        offset: int,
        page_size: int,
        categories: list[str] | None = None,
        values: list[str] | None = None,
        operations: list[Operation] | None = None,
    ) -> tuple[list[Trace],
               int]:
        """Fetch a batch of traces from log search results, applying categorical filters.

        This method handles pagination through trace IDs found in log search. When
        categorical filters are applied, it may need to fetch multiple batches to
        find matching traces (since filtering happens in get_trace_by_id).

        Args:
            observe_provider: Observability provider instance
            trace_id_to_metadata: Dict mapping trace_id to metadata
                {
                    'trace-id-1': {
                        'start_time': datetime,
                        'end_time': datetime,
                        'log_stream': str
                    }
                }
            offset: Starting offset in trace ID list
            page_size: Number of traces to fetch per batch
            categories: Filter by categories if provided
            values: Filter by values if provided
            operations: Filter by operations if provided

        Returns:
            Tuple of (matching traces, final offset used)

        Note:
            When categorical filters result in 0 matches for a batch, this method
            automatically fetches the next batch until matches are found or all
            trace IDs are exhausted.
        """
        # NOTE: When categorical filters are applied, we may need to fetch
        # multiple batches to find matching traces (since traces are filtered
        # one-by-one in get_trace_by_id). Keep fetching until we get results
        # or exhaust all available trace IDs.
        has_categorical_filter = categories is not None and values is not None

        # Convert dict to ordered list of trace IDs for pagination
        trace_ids_ordered = list(trace_id_to_metadata.keys())

        traces = []
        current_offset = offset
        batches_tried = 0

        # Keep fetching batches until we find matches or exhaust all trace IDs
        # No arbitrary limit - bounded naturally by total trace IDs and timeouts
        while True:
            # Get batch for current offset
            current_batch = trace_ids_ordered[current_offset:current_offset + page_size]
            if not current_batch:
                self.logger.debug(f"No more trace IDs at offset {current_offset}")
                break

            batches_tried += 1
            self.logger.debug(
                f"Batch {batches_tried}: Fetching {len(current_batch)} traces "
                f"from offset {current_offset}..."
            )

            # Fetch traces for this batch
            batch_traces = []
            for i, trace_id in enumerate(current_batch):
                self.logger.debug(
                    f"Fetching trace {i+1}/{len(current_batch)}: {trace_id}"
                )

                # Get metadata for this trace from the trace_id -> metadata mapping
                metadata = trace_id_to_metadata.get(trace_id, {})
                log_start_time = metadata.get('start_time')
                log_end_time = metadata.get('end_time')
                log_stream = metadata.get('log_stream')

                self.logger.debug(
                    f"[_fetch_trace_batch] Trace {trace_id}: "
                    f"start_time={log_start_time}, end_time={log_end_time}, "
                    f"log_stream={log_stream}"
                )

                trace = await observe_provider.trace_client.get_trace_by_id(
                    trace_id=trace_id,
                    categories=categories,
                    values=values,
                    operations=operations,
                    log_start_time=log_start_time,
                    log_end_time=log_end_time,
                    log_stream=log_stream,
                )
                if trace:
                    batch_traces.append(trace)
                    self.logger.debug("Trace fetched successfully")
                else:
                    self.logger.debug("Trace not found or filtered out")

            traces.extend(batch_traces)
            self.logger.debug(
                f"Batch {batches_tried} yielded {len(batch_traces)} matching traces"
            )

            # If we got results OR no categorical filter OR no more traces,
            # stop and return
            if len(
                traces
            ) > 0 or not has_categorical_filter or current_offset + page_size > len(
                trace_ids_ordered
            ):
                if batches_tried > 1 and len(traces) > 0:
                    self.logger.info(
                        f"✓ Found {len(traces)} matching traces after "
                        f"checking {batches_tried} batches"
                    )
                break

            # No matches yet, try next batch
            self.logger.debug(
                f"⚠️ Batch {batches_tried}: Categorical filter found 0 matches, "
                f"trying next batch..."
            )
            current_offset += page_size

        self.logger.info(
            f"Successfully fetched {len(traces)} traces total "
            f"(tried {batches_tried} batches)"
        )

        return traces, current_offset
