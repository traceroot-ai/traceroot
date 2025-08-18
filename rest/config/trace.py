from datetime import datetime, timezone

from pydantic import BaseModel, Field, field_validator


class ListTraceRawRequest(BaseModel):
    r"""Raw request model for listing traces from FastAPI query parameters.
    """
    start_time: datetime
    end_time: datetime
    categories: str | None = None
    values: str | None = None
    operations: str | None = None

    @field_validator('start_time', 'end_time')
    @classmethod
    def ensure_utc_timezone(cls, v: datetime) -> datetime:
        r"""Ensure datetime is timezone-aware and in UTC.

        Args:
            v: datetime value from request

        Returns:
            datetime in UTC timezone
        """
        if v.tzinfo is None:
            # If timezone-naive, assume UTC
            return v.replace(tzinfo=timezone.utc)
        else:
            # If timezone-aware, convert to UTC
            return v.astimezone(timezone.utc)

    def to_list_trace_request(self, request) -> 'ListTraceRequest':
        r"""Convert raw request to ListTraceRequest with proper list parsing.

        Args:
            request: FastAPI request object to parse multi-value parameters

        Returns:
            ListTraceRequest with properly parsed list parameters
        """
        # Handle multiple values for the same parameter name
        query_params = request.query_params
        categories = []
        values = []
        operations = []

        for key, value in query_params.multi_items():
            if key == 'categories':
                categories.append(value)
            elif key == 'service_name':
                # Merge service_name into categories
                categories.append(value)
            elif key == 'values':
                values.append(value)
            elif key == 'operations':
                operations.append(value)

        return ListTraceRequest(
            start_time=self.start_time,
            end_time=self.end_time,
            categories=categories,
            values=values,
            operations=operations
        )


class ListTraceRequest(BaseModel):
    r"""Request model for listing traces.
    """
    start_time: datetime
    end_time: datetime
    categories: list[str] = []
    values: list[str] = []
    operations: list[str] = []

    @field_validator('start_time', 'end_time')
    @classmethod
    def ensure_utc_timezone(cls, v: datetime) -> datetime:
        r"""Ensure datetime is timezone-aware and in UTC.

        Args:
            v: datetime value from request

        Returns:
            datetime in UTC timezone
        """
        if v.tzinfo is None:
            # If timezone-naive, assume UTC
            return v.replace(tzinfo=timezone.utc)
        else:
            # If timezone-aware, convert to UTC
            return v.astimezone(timezone.utc)


class Span(BaseModel):
    r"""Span model.
    """
    id: str
    parent_id: str | None
    name: str
    start_time: float
    end_time: float
    duration: float
    num_debug_logs: int | None = None
    num_info_logs: int | None = None
    num_warning_logs: int | None = None
    num_error_logs: int | None = None
    num_critical_logs: int | None = None
    telemetry_sdk_language: str | None = None
    spans: list['Span'] = Field(default_factory=list)


class Trace(BaseModel):
    r"""Trace model.
    """
    id: str
    start_time: float
    end_time: float
    duration: float
    percentile: str
    spans: list[Span] = Field(default_factory=list)
    service_name: str | None = None
    service_environment: str | None = None
    num_debug_logs: int | None = None
    num_info_logs: int | None = None
    num_warning_logs: int | None = None
    num_error_logs: int | None = None
    num_critical_logs: int | None = None
    telemetry_sdk_language: set[str] = Field(default_factory=set)


class ListTraceResponse(BaseModel):
    r"""Response model for listing traces.
    """
    traces: list[Trace] = Field(default_factory=list)
