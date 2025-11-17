"""Cache utilities for trace and log queries.

This module provides a helper class for caching trace and log query results,
handling cache key generation, retrieval, and storage with proper typing.

The cache system is used to:
- Cache trace query results to reduce load on trace providers (AWS X-Ray, Tencent APM)
- Cache log query results to reduce load on log providers (CloudWatch Logs)
- Cache log search results (trace IDs) to enable efficient pagination
- Improve response times for repeated queries

Cache Key Structures:
    Trace Queries:
        (start_time, end_time, tuple(categories), tuple(values),
         tuple(operations), log_group_name, pagination_token)

    Log Queries:
        (trace_id, start_time, end_time, log_group_name)

    Log Search Trace IDs:
        "log_search_trace_ids:{md5_hash}"

    Simple Trace Cache (for chatbot/internal use):
        (start_time, end_time, service_name, log_group_name)
"""

from datetime import datetime

from rest.cache import Cache, CacheType
from rest.config import Trace, TraceLogs


class TraceCacheHelper:
    """Helper for trace caching operations.

    This helper provides a clean interface for caching trace query results
    and related data. It encapsulates:
    - Cache key generation with consistent structure
    - Type-safe retrieval of cached traces
    - Storage of trace results with pagination state

    Usage:
        >>> cache = Cache()
        >>> helper = TraceCacheHelper(cache)

        # Build cache key
        >>> key = helper.build_cache_key(
        ...     start_time=datetime.now(),
        ...     end_time=datetime.now(),
        ...     categories=['service_name'],
        ...     values=['my-service'],
        ...     operations=['='],
        ...     log_group_name='my-logs',
        ...     pagination_token=None
        ... )

        # Try to get cached traces
        >>> result = await helper.get_traces(key)
        >>> if result:
        ...     traces, next_state = result
        ...     print(f"Found {len(traces)} cached traces")

        # Cache new results
        >>> await helper.cache_traces(key, traces, next_state)
    """

    def __init__(self, cache: Cache):
        """Initialize the trace cache helper.

        Args:
            cache: Cache instance to use for storage/retrieval
        """
        self.cache = cache

    def build_cache_key(
        self,
        start_time: datetime,
        end_time: datetime,
        categories: list[str],
        values: list[str],
        operations: list[str],
        log_group_name: str,
        pagination_token: str | None,
    ) -> tuple:
        """Build cache key for trace query.

        Creates a consistent cache key tuple from query parameters. The key
        includes all parameters that affect query results to ensure proper
        cache hit/miss behavior.

        Args:
            start_time: Query start time
            end_time: Query end time
            categories: Filter categories (e.g., ['service_name', 'status'])
            values: Filter values (e.g., ['my-service', 'error'])
            operations: Filter operations (e.g., ['=', 'contains'])
            log_group_name: Log group name for filtering
            pagination_token: Pagination token string, or None for first page

        Returns:
            Cache key tuple that uniquely identifies this query

        Note:
            Lists are converted to tuples for hashability. The pagination token
            is normalized to 'first_page' when None to distinguish from
            subsequent pages.

        Example:
            >>> key = helper.build_cache_key(
            ...     start_time=datetime(2024, 1, 1, 0, 0, 0),
            ...     end_time=datetime(2024, 1, 1, 1, 0, 0),
            ...     categories=['service_name'],
            ...     values=['api-service'],
            ...     operations=['='],
            ...     log_group_name='prod-logs',
            ...     pagination_token=None
            ... )
            >>> key
            (datetime(...), datetime(...), ('service_name',), ('api-service',),
             ('=',), 'prod-logs', 'first_page')
        """
        return (
            start_time,
            end_time,
            tuple(categories),
            tuple(values),
            tuple(operations),
            log_group_name,
            pagination_token or 'first_page'
        )

    async def get_traces(
        self,
        cache_key: tuple,
    ) -> tuple[list[Trace],
               dict | None] | None:
        """Get cached traces if available.

        Attempts to retrieve cached trace query results. Returns None if
        cache miss or cache expired.

        Args:
            cache_key: Cache key tuple from build_cache_key()

        Returns:
            Tuple of (traces, next_pagination_state) if cached, None otherwise
            - traces: List of Trace objects
            - next_pagination_state: Dict for next page, or None if last page

        Example:
            >>> result = await helper.get_traces(cache_key)
            >>> if result:
            ...     traces, next_state = result
            ...     print(f"Cache hit: {len(traces)} traces")
            ... else:
            ...     print("Cache miss")
        """
        return await self.cache[CacheType.TRACE].get(cache_key)

    async def cache_traces(
        self,
        cache_key: tuple,
        traces: list[Trace],
        next_state: dict | None,
    ) -> None:
        """Cache trace query results.

        Stores trace query results in the cache with a TTL (typically 10 minutes).
        Includes both the traces and the pagination state for the next page.

        Args:
            cache_key: Cache key tuple from build_cache_key()
            traces: List of Trace objects to cache
            next_state: Pagination state dict for next page, or None if last page

        Note:
            The cache TTL is configured in the Cache class (default 10 minutes).
            After TTL expires, the next query will be a cache miss.

        Example:
            >>> await helper.cache_traces(
            ...     cache_key=cache_key,
            ...     traces=[trace1, trace2, trace3],
            ...     next_state={'provider': 'aws', 'chunk_index': 1}
            ... )
        """
        await self.cache[CacheType.TRACE].set(cache_key, (traces, next_state))

    async def get_trace_metadata(
        self,
        cache_key: str,
    ) -> dict[str,
              dict] | None:
        """Get cached trace metadata from log search.

        Retrieves cached trace metadata dict from a log search query. Each trace
        has associated metadata including timestamps and log stream information.

        Args:
            cache_key: String cache key (e.g., 'log_search_trace_ids:abc123')

        Returns:
            Dict mapping trace_id to metadata {start_time, end_time, log_stream},
            or None if not cached

        Example:
            >>> metadata = await helper.get_trace_metadata('log_search_trace_ids:abc')
            >>> if metadata:
            ...     print(f"Found {len(metadata)} cached trace metadata entries")
            ...     for trace_id, meta in metadata.items():
            ...         print(f"{trace_id}: {meta['start_time']} to {meta['end_time']}")
        """
        return await self.cache[CacheType.TRACE].get(cache_key)

    async def cache_trace_metadata(
        self,
        cache_key: str,
        trace_id_to_metadata: dict[str,
                                   dict],
    ) -> None:
        """Cache trace metadata from log search.

        Stores trace metadata dict from a log search query. The metadata includes
        timestamps and log stream for each trace, enabling log-only trace creation.

        Args:
            cache_key: String cache key (e.g., 'log_search_trace_ids:abc123')
            trace_id_to_metadata: Dict mapping trace_id to metadata:
                {
                    'trace-1': {
                        'start_time': datetime,
                        'end_time': datetime,
                        'log_stream': str
                    },
                    'trace-2': {...}
                }

        Note:
            This is specifically for log search pagination. The cache stores ALL
            matching trace metadata so we can efficiently paginate without re-querying
            CloudWatch Logs.

        Example:
            >>> await helper.cache_trace_metadata(
            ...     cache_key='log_search_trace_ids:abc123',
            ...     trace_id_to_metadata={
            ...         'trace-1': {
            ...             'start_time': datetime.now(),
            ...             'end_time': datetime.now(),
            ...             'log_stream': 'my-service-prod'
            ...         }
            ...     }
            ... )
        """
        await self.cache[CacheType.TRACE].set(cache_key, trace_id_to_metadata)

    def build_log_cache_key(
        self,
        trace_id: str,
        start_time: datetime,
        end_time: datetime,
        log_group_name: str,
    ) -> tuple:
        """Build cache key for log queries.

        Creates a consistent cache key tuple for log queries by trace ID.
        This is used to cache CloudWatch Logs results.

        Args:
            trace_id: Trace ID to get logs for
            start_time: Log query start time
            end_time: Log query end time
            log_group_name: Log group name

        Returns:
            Cache key tuple for log queries

        Example:
            >>> key = helper.build_log_cache_key(
            ...     trace_id='1-abc123-def456',
            ...     start_time=datetime(2024, 1, 1, 0, 0, 0),
            ...     end_time=datetime(2024, 1, 1, 1, 0, 0),
            ...     log_group_name='prod-logs'
            ... )
            >>> key
            ('1-abc123-def456', datetime(...), datetime(...), 'prod-logs')
        """
        return (trace_id, start_time, end_time, log_group_name)

    async def get_logs(
        self,
        cache_key: tuple,
    ) -> TraceLogs | None:
        """Get cached logs if available.

        Attempts to retrieve cached log query results. Returns None if
        cache miss or cache expired.

        Args:
            cache_key: Cache key tuple from build_log_cache_key()

        Returns:
            TraceLogs object if cached, None otherwise

        Example:
            >>> logs = await helper.get_logs(cache_key)
            >>> if logs:
            ...     print(f"Cache hit: {len(logs.logs)} log entries")
            ... else:
            ...     print("Cache miss")
        """
        return await self.cache[CacheType.LOG].get(cache_key)

    async def cache_logs(
        self,
        cache_key: tuple,
        logs: TraceLogs,
    ) -> None:
        """Cache log query results.

        Stores log query results in the cache with a TTL (typically 10 minutes).

        Args:
            cache_key: Cache key tuple from build_log_cache_key()
            logs: TraceLogs object to cache

        Note:
            The cache TTL is configured in the Cache class (default 10 minutes).

        Example:
            >>> await helper.cache_logs(
            ...     cache_key=cache_key,
            ...     logs=TraceLogs(logs=[...])
            ... )
        """
        await self.cache[CacheType.LOG].set(cache_key, logs)

    def build_simple_trace_cache_key(
        self,
        start_time: datetime,
        end_time: datetime,
        service_name: str,
        log_group_name: str,
    ) -> tuple:
        """Build simple cache key for trace queries (chatbot/internal use).

        Creates a simpler cache key for internal trace queries that don't
        need the full filter parameters. Used primarily by chatbot and
        internal analysis tools.

        Args:
            start_time: Query start time
            end_time: Query end time
            service_name: Service name filter
            log_group_name: Log group name

        Returns:
            Simple cache key tuple

        Example:
            >>> key = helper.build_simple_trace_cache_key(
            ...     start_time=datetime(2024, 1, 1, 0, 0, 0),
            ...     end_time=datetime(2024, 1, 1, 1, 0, 0),
            ...     service_name='api-service',
            ...     log_group_name='prod-logs'
            ... )
            >>> key
            (datetime(...), datetime(...), 'api-service', 'prod-logs')
        """
        return (start_time, end_time, service_name, log_group_name)

    async def get_simple_traces(
        self,
        cache_key: tuple,
    ) -> list[Trace] | None:
        """Get cached traces using simple cache key.

        Retrieves traces cached with the simple key format (used by chatbot
        and internal tools).

        Args:
            cache_key: Cache key tuple from build_simple_trace_cache_key()

        Returns:
            List of Trace objects if cached, None otherwise

        Example:
            >>> traces = await helper.get_simple_traces(cache_key)
            >>> if traces:
            ...     print(f"Cache hit: {len(traces)} traces")
        """
        return await self.cache[CacheType.TRACE].get(cache_key)

    async def cache_simple_traces(
        self,
        cache_key: tuple,
        traces: list[Trace],
    ) -> None:
        """Cache traces using simple cache key.

        Stores traces using the simple key format (used by chatbot and
        internal tools).

        Args:
            cache_key: Cache key tuple from build_simple_trace_cache_key()
            traces: List of Trace objects to cache

        Example:
            >>> await helper.cache_simple_traces(
            ...     cache_key=cache_key,
            ...     traces=[trace1, trace2, trace3]
            ... )
        """
        await self.cache[CacheType.TRACE].set(cache_key, traces)
