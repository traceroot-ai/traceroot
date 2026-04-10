"""Common API response schemas."""

from pydantic import BaseModel


class HealthResponse(BaseModel):
    """Health check response."""

    status: str


class PaginationMeta(BaseModel):
    """Basic pagination metadata."""

    page: int
    limit: int
    total: int


class AggregatedMetricsMeta(PaginationMeta):
    """Pagination metadata plus aggregated token and cost totals."""

    total_input_tokens: int | None = 0
    total_output_tokens: int | None = 0
    total_cost: float | None = 0.0
