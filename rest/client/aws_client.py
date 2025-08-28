from datetime import datetime
from typing import Any

from rest.config.log import TraceLogs
from rest.config.trace import Span, Trace


class TraceRootAWSClient:
    r"""Client for querying logs and traces from AWS CloudWatch
    and X-Ray
    """

    def __init__(
        self,
        aws_region: str | None = None,
    ):
        pass

    async def get_logs_by_trace_id(
        self,
        trace_id: str,
        start_time: datetime,
        end_time: datetime,
        log_group_name: str | None = None,
        log_search_term: str | None = None,
    ) -> TraceLogs:
        pass

    async def _filter_log_events(self, filter_params: dict) -> dict[str, Any]:
        pass

    async def get_trace_ids_from_logs(
        self,
        start_time: datetime,
        end_time: datetime,
        log_group_name: str,
        search_term: str,
    ) -> list[str]:
        """Get trace IDs from logs using CloudWatch Insights (stub implementation)."""
        return []

    async def get_trace_with_spans_by_ids(
        self,
        trace_ids: list[str],
    ) -> dict[str,
              list[Span]]:
        pass

    async def _batch_get_traces(
        self,
        trace_ids: list[str],
        next_token: str | None = None,
    ) -> dict[str,
              Any]:
        pass

    async def get_recent_traces(
        self,
        start_time: datetime,
        end_time: datetime,
        log_group_name: str,
        service_names: list[str] | None = None,
        service_name_values: list[str] | None = None,
        service_name_operations: list[str] | None = None,
        service_environments: list[str] | None = None,
        service_environment_values: list[str] | None = None,
        service_environment_operations: list[str] | None = None,
        categories: list[str] | None = None,
        values: list[str] | None = None,
        operations: list[str] | None = None,
    ) -> list[Trace]:
        pass

    async def _get_trace_summaries(self, params: dict) -> dict[str, Any]:
        pass
