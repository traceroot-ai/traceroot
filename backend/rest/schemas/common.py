"""Common API response schemas."""

from pydantic import BaseModel, Field


class HealthResponse(BaseModel):
    """Health check response."""

    status: str = Field(description="Service health status. `ok` when the API is healthy.")


class PaginationMeta(BaseModel):
    """Pagination metadata for list responses."""

    page: int
    limit: int
    total: int
