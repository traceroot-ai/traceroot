from abc import ABC, abstractmethod
from datetime import datetime

from rest.config.log import TraceLogs
from rest.config.trace import Span, Trace


class TraceRootClient(ABC):
    """Abstract base class for TraceRoot clients that query logs and traces
    from different observability backends.
    """

    @abstractmethod
    async def get_logs_by_trace_id(
        self,
        trace_id: str,
        start_time: datetime,
        end_time: datetime,
        log_group_name: str | None = None,
        log_search_term: str | None = None,
    ) -> TraceLogs:
        """Query logs by trace ID.

        Args:
            trace_id: Trace identifier
            start_time: Start time of the trace
            end_time: End time of the trace
            log_group_name: Log group name (provider-specific)
            log_search_term: Additional search term to filter logs

        Returns:
            TraceLogs: Trace logs for the given trace ID
        """

    @abstractmethod
    async def get_trace_ids_from_logs(
        self,
        start_time: datetime,
        end_time: datetime,
        log_group_name: str,
        search_term: str,
    ) -> list[str]:
        """Get trace IDs from logs.

        Args:
            start_time: Start time for log query
            end_time: End time for log query
            log_group_name: Log group name
            search_term: Search term to look for in log messages

        Returns:
            List of unique trace IDs found in logs containing the search term
        """

    @abstractmethod
    async def get_trace_with_spans_by_ids(
        self,
        trace_ids: list[str],
        categories: list[str] | None = None,
        values: list[str] | None = None,
        operations: list[str] | None = None,
    ) -> dict[str,
              list[Span]]:
        """Get traces with spans by trace IDs.

        Args:
            trace_ids: List of trace identifiers
            categories: Filter by categories if provided
            values: Filter by values if provided
            operations: Filter by operations for values if provided

        Returns:
            Dictionary mapping trace_id to list of spans
        """

    @abstractmethod
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
    ) -> list[Trace]:
        """Get recent traces.

        Args:
            start_time: Start time of the trace
            end_time: End time of the trace
            log_group_name: The log group name
            service_name_values: Filter values for service names if provided
            service_name_operations: Filter operations for service names if provided
            service_environment_values: Filter values for service environments if provided
            service_environment_operations: Filter operations for service environments
                if provided
            categories: Filter by categories if provided
            values: Filter by values if provided
            operations: Filter by operations for values if provided

        Returns:
            List of traces
        """
