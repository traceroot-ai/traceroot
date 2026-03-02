"""Session-related response schemas."""

from datetime import datetime

from pydantic import BaseModel

from rest.schemas.common import PaginationMeta


class SessionListItem(BaseModel):
    """Single session with aggregated trace statistics."""

    session_id: str
    trace_count: int
    user_ids: list[str]
    first_trace_time: datetime | None
    last_trace_time: datetime | None
    duration_ms: float | None
    total_input_tokens: int | None
    total_output_tokens: int | None
    input: str | None
    output: str | None


class SessionListResponse(BaseModel):
    """Paginated list of sessions."""

    data: list[SessionListItem]
    meta: PaginationMeta


class SessionTraceItem(BaseModel):
    """Single trace within a session, for conversation view."""

    trace_id: str
    name: str
    trace_start_time: datetime
    user_id: str | None
    input: str | None
    output: str | None
    duration_ms: float | None
    status: str


class SessionDetailResponse(BaseModel):
    """Session detail with all traces for conversation view."""

    session_id: str
    traces: list[SessionTraceItem]
    user_ids: list[str]
    trace_count: int
    first_trace_time: datetime | None
    last_trace_time: datetime | None
    duration_ms: float | None
    total_input_tokens: int | None
    total_output_tokens: int | None
