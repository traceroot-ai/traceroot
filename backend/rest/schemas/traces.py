"""Trace-related response schemas."""

from datetime import datetime

from pydantic import BaseModel

from rest.schemas.common import PaginationMeta


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
    input_tokens: int | None
    output_tokens: int | None
    total_tokens: int | None
    input: str | None
    output: str | None
    metadata: str | None


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
    input: str | None
    output: str | None


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
    metadata: str | None
    spans: list[SpanResponse]
