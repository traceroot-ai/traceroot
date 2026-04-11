"""User-related response schemas."""

from datetime import datetime

from pydantic import BaseModel

from rest.schemas.common import PaginationMeta


class UserItem(BaseModel):
    """Single user with trace statistics."""

    user_id: str
    trace_count: int
    last_trace_time: datetime | None
    total_tokens: int | None = 0
    total_cost: float | None = 0.0


class UserListResponse(BaseModel):
    """Paginated list of users."""

    data: list[UserItem]
    meta: PaginationMeta
