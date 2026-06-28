"""Common API response schemas."""

from datetime import datetime
from typing import Annotated

from pydantic import BaseModel, PlainSerializer

from shared.datetime_utils import to_utc_aware

UtcDatetime = Annotated[
    datetime,
    PlainSerializer(lambda dt: to_utc_aware(dt).isoformat(), return_type=str, when_used="json"),
]


class HealthResponse(BaseModel):
    """Health check response."""

    status: str


class PaginationMeta(BaseModel):
    """Pagination metadata for list responses."""

    page: int
    limit: int
    total: int
