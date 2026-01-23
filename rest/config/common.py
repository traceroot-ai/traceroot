"""Common schemas shared across endpoints."""

from pydantic import BaseModel


class PaginationMeta(BaseModel):
    """Pagination metadata for list responses."""

    page: int
    limit: int
    total: int
