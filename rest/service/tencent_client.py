from datetime import datetime
from typing import Any

from rest.config.log import TraceLogs
from rest.config.trace import Span, Trace
from rest.service.service_client import TraceRootClient


class TraceRootTencentClient(TraceRootClient):
    r"""Client for querying logs and traces from Tencent Cloud CLS
    and APM.
    """

    def __init__(
        self,
        tencent_region: str | None = None,
    ):
        """Initialize the TraceRoot Tencent client.

        Args:
            tencent_region (str | None): Tencent Cloud region to use.
        """

    async def get_logs_by_trace_id(
        self,
        trace_id: str,
        start_time: datetime,
        end_time: datetime,
        log_group_name: str | None = None,
        log_search_term: str | None = None,
    ) -> TraceLogs:
        r"""Query Tencent CLS logs by trace ID.

        Args:
            trace_id (str): Tencent APM format trace ID
            start_time (datetime): Start time of the trace
            end_time (datetime): End time of the trace
            log_group_name (str, optional): CLS log topic ID.
                Uses config default if not provided.
            log_search_term (str, optional): Additional search term to filter logs.
                If provided, only logs containing this term will be returned.

        Returns:
            TraceLogs: Trace logs for the given trace ID
        """

    async def _filter_log_events(self, filter_params: dict) -> dict[str, Any]:
        """Filter log events using Tencent CLS client.

        Args:
            filter_params (dict): Dictionary containing:
                - topic_id: CLS topic ID
                - query: Search query string
                - start_time: Start timestamp in milliseconds
                - end_time: End timestamp in milliseconds
                - context: Optional pagination context

        Returns:
            dict[str, Any]: Dictionary with 'events' and optional 'context' for pagination
        """

    async def get_trace_ids_from_logs(
        self,
        start_time: datetime,
        end_time: datetime,
        log_group_name: str,
        search_term: str,
    ) -> list[str]:
        """Get trace IDs from logs using Tencent CLS.

        Args:
            start_time (datetime): Start time for log query
            end_time (datetime): End time for log query
            log_group_name (str): CLS log topic name
            search_term (str): Search term to look for in log messages

        Returns:
            list[str]: List of unique trace IDs found in logs containing the search term
        """
        return []

    async def get_trace_with_spans_by_ids(
        self,
        trace_ids: list[str],
        categories: list[str] | None = None,
        values: list[str] | None = None,
        operations: list[str] | None = None,
    ) -> dict[str,
              list[Span]]:
        r"""Get Tencent APM trace with spans by trace ID.

        Args:
            trace_ids (list[str]): List of Tencent APM format trace IDs.
            categories (list[str], optional): Filter by categories if provided
            values (list[str], optional): Filter by values if provided
            operations (list[str], optional): Filter by operations for values if provided

        Returns:
            dict[str, list[Span]]: Dictionary of trace_id and list of spans.
        """

    async def _batch_get_traces(
        self,
        trace_ids: list[str],
        next_token: str | None = None,
    ) -> dict[str,
              Any]:
        """Batch get traces using Tencent APM client.

        Args:
            trace_ids (list[str]): List of trace IDs to fetch
            next_token (str | None): Optional pagination token

        Returns:
            dict[str, Any]: Response containing traces and pagination info
        """

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
        r"""Get recent traces from Tencent APM.

        Args:
            start_time (datetime): Start time of the trace
            end_time (datetime): End time of the trace
            log_group_name (str): The Tencent APM Instance ID
            service_name_values (list[str], optional): Filter values for service names
            service_name_operations (list[str], optional): Filter operations
                for service names
            service_environment_values (list[str], optional): Filter values for
                service environments
            service_environment_operations (list[str], optional): Filter operations for
                service environments
            categories (list[str], optional): Filter by categories if provided
            values (list[str], optional): Filter by values if provided
            operations (list[str], optional): Filter by operations for values if provided

        Returns:
            list[Trace]: List of traces
        """

    async def _get_trace_summaries(self, params: dict) -> dict[str, Any]:
        """Get trace summaries using Tencent APM client.

        Args:
            params (dict): Query parameters including start_time, end_time, and filters

        Returns:
            dict[str, Any]: Response containing trace summaries and pagination info
        """
