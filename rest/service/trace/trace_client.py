from abc import ABC, abstractmethod
from datetime import datetime

from rest.config.trace import Span, Trace


class TraceClient(ABC):
    """Abstract base class for trace clients that query traces
    from different observability backends.
    """

    @abstractmethod
    async def get_trace_by_id(
        self,
        trace_id: str,
        categories: list[str] | None = None,
        values: list[str] | None = None,
        operations: list[str] | None = None,
    ) -> Trace | None:
        """Get a single trace by trace ID with full metadata.

        Args:
            trace_id: Trace identifier
            categories: Filter by categories if provided
            values: Filter by values if provided
            operations: Filter by operations for values if provided

        Returns:
            Trace object with full metadata (service_name, service_environment, etc.)
            or None if trace not found
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
