"""Trace-related response schemas."""

from datetime import datetime

from pydantic import BaseModel

from rest.schemas.common import PaginationMeta


class SpanSkeletonResponse(BaseModel):
    """Span skeleton — tree-building / display fields only, no I/O blobs.

    Used by the trace-detail endpoint so the initial payload stays sub-MB
    regardless of trace size. Full I/O (input/output/metadata) is fetched
    per-span on demand via the dedicated ``/spans/{span_id}/io`` endpoint.

    Note: the token/cost breakdown maps (``usage_details``/``cost_details``)
    stay on the skeleton — they are small and drive the tree's token/cost
    chips. Only the large free-text I/O blobs are omitted.
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
    usage_details: dict[str, int] = {}
    cost_details: dict[str, float] = {}
    git_source_file: str | None = None
    git_source_line: int | None = None
    git_source_function: str | None = None


class SpanResponse(SpanSkeletonResponse):
    """A span skeleton plus its per-span I/O blobs (``input``/``output``/``metadata``).

    The projection-capable superset returned by the trace get/export endpoints.
    The blobs default to ``None`` and are populated only when the caller requests
    the matching field group (``io``/``metadata``; see
    ``rest.projection``). The default ``skeleton`` projection leaves them ``None``
    and never runs the bulk span-I/O query, so there is no payload or query-cost
    regression for the dashboard. Keeping the fields present (as ``null``) rather
    than omitting them is additive: a few bytes per span, and it matches the
    fields the shipped CLI's generated types already declare.

    One internal-only exception: the dashboard's trace-detail read leaves a small
    SDK span-path subset in ``metadata`` on the skeleton, which it needs to
    rebuild the tree of an in-flight trace. The public routes drop it (see
    ``rest.projection.drop_span_tree_metadata``), so for API clients the contract
    above holds exactly: ``metadata`` is ``null`` unless requested.
    """

    input: str | None = None
    output: str | None = None
    metadata: str | None = None
    events: str | None = None


class SpanIOResponse(BaseModel):
    """Full I/O payload for a single span, fetched on demand."""

    span_id: str
    trace_id: str
    input: str | None
    output: str | None
    metadata: str | None
    events: str | None = None


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
    """Single trace with its spans.

    Spans use ``SpanResponse`` (the skeleton superset): per-span ``input``/
    ``output``/``metadata`` are present but default to ``None``. They are
    populated only when the caller requests the matching ``io``/``metadata``
    field group (see ``rest.projection``); the default ``skeleton`` projection
    leaves them ``None`` and never runs the bulk span-I/O query, preserving the
    #1040 lightweight behavior. The one exception is the dashboard's span-path
    metadata subset — see ``SpanResponse``; the public routes drop it.
    """

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
    spans: list[SpanResponse]


class FilterField(BaseModel):
    """A single filterable column, serialized from the registry for the UI."""

    field: str
    label: str
    type: str
    level: str
    operators: list[str]
    value_source: str
    enum_values: list[str] = []
    # True for integer-typed numeric fields (tokens/latency/errors), so the UI can
    # restrict their inputs to whole numbers.
    integer: bool = False


class FilterFieldsResponse(BaseModel):
    """The full set of filterable fields driving the filter dropdown."""

    fields: list[FilterField]


class FilterValueCount(BaseModel):
    """A distinct categorical value and how often it occurs."""

    value: str
    count: int


class FilterValuesResponse(BaseModel):
    """Distinct values for one categorical filter field, by frequency."""

    field: str
    values: list[FilterValueCount]
