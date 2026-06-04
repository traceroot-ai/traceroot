"""Trace-related response schemas."""

from datetime import datetime

from pydantic import BaseModel

from rest.schemas.common import PaginationMeta


class SpanResponse(BaseModel):
    """Single span in a trace (full payload including I/O)."""

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
    git_source_file: str | None = None
    git_source_line: int | None = None
    git_source_function: str | None = None


class SpanSkeletonResponse(BaseModel):
    """Span skeleton — tree-building fields only, no I/O blobs.

    Used by the trace-detail endpoint so the initial payload stays sub-MB
    regardless of trace size. Full I/O is fetched per-span on demand via
    the dedicated ``/spans/{span_id}/io`` endpoint.
    """

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
    git_source_file: str | None = None
    git_source_line: int | None = None
    git_source_function: str | None = None


class SpanIOResponse(BaseModel):
    """Full I/O payload for a single span, fetched on demand."""

    span_id: str
    trace_id: str
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
    error_count: int
    input: str | None
    output: str | None
    total_input_tokens: int | None = 0
    total_output_tokens: int | None = 0
    total_cost: float | None = 0.0


class TraceListResponse(BaseModel):
    """Paginated list of traces."""

    data: list[TraceListItem]
    meta: PaginationMeta


class TraceDetailResponse(BaseModel):
    """Single trace with span skeletons (no per-span I/O)."""

    trace_id: str
    project_id: str
    name: str
    trace_start_time: datetime
    user_id: str | None
    session_id: str | None
    git_ref: str | None
    git_repo: str | None
    input: str | None
    output: str | None
    metadata: str | None
    spans: list[SpanSkeletonResponse]
