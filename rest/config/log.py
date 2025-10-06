from datetime import datetime, timezone

from pydantic import BaseModel, Field, field_validator


class LogEntry(BaseModel):
    time: float
    level: str
    message: str
    function_name: str
    file_name: str
    line_number: int
    git_url: str | None = None
    commit_id: str | None = None
    line: str | None = None
    lines_above: list[str] | None = None
    lines_below: list[str] | None = None


class TraceLogs(BaseModel):
    logs: list[dict[str, list[LogEntry]]] = Field(default_factory=list)


class GetLogByTraceIdRequest(BaseModel):
    trace_id: str
    start_time: datetime | None = None
    end_time: datetime | None = None
    trace_provider: str
    log_provider: str
    log_group_name: str | None = None
    trace_region: str | None = None
    log_region: str | None = None

    @field_validator('start_time', 'end_time')
    @classmethod
    def ensure_utc_timezone(cls, v: datetime | None) -> datetime | None:
        r"""Ensure datetime is timezone-aware and in UTC.

        Args:
            v: datetime value from request (can be None)

        Returns:
            datetime in UTC timezone or None
        """
        if v is None:
            return None
        if v.tzinfo is None:
            # If timezone-naive, assume UTC
            return v.replace(tzinfo=timezone.utc)
        else:
            # If timezone-aware, convert to UTC
            return v.astimezone(timezone.utc)


class GetLogByTraceIdResponse(BaseModel):
    trace_id: str
    logs: TraceLogs
