"""Common API response schemas."""

from pydantic import BaseModel


class HealthResponse(BaseModel):
    """Health check response."""

    status: str


class PaginationMeta(BaseModel):
    """Pagination metadata for list responses."""

    page: int
    limit: int
    total: int
