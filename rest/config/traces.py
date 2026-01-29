"""Trace schemas for request/response validation."""

from datetime import datetime

from pydantic import BaseModel


class SpanResponse(BaseModel):
    """Single span in a trace."""

    span_id: str
    trace_id: str
    parent_span_id: str | None
    name: str
    span_kind: str
    span_start_time: datetime
    span_end_time: datetime | None
    status: str
    status_message: str | None
    model_name: str | None
    cost: float | None
    input: str | None
    output: str | None


class TraceListItem(BaseModel):
    """Trace summary for list view."""

    trace_id: str
    project_id: str
    name: str
    trace_start_time: datetime
    user_id: str | None
    session_id: str | None
    span_count: int
    duration_ms: float | None
    status: str  # "ok" or "error"


class PaginationMeta(BaseModel):
    """Pagination metadata."""

    page: int
    limit: int
    total: int


class TraceListResponse(BaseModel):
    """Paginated list of traces."""

    data: list[TraceListItem]
    meta: PaginationMeta


class TraceDetailResponse(BaseModel):
    """Single trace with all spans."""

    trace_id: str
    project_id: str
    name: str
    trace_start_time: datetime
    user_id: str | None
    session_id: str | None
    environment: str
    release: str | None
    input: str | None
    output: str | None
    spans: list[SpanResponse]
