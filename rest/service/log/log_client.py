from abc import ABC, abstractmethod
from datetime import datetime

from rest.config.log import TraceLogs


class LogClient(ABC):
    """Abstract base class for log clients that query logs
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
