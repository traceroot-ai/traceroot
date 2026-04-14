"""User-related response schemas."""

from datetime import datetime

from pydantic import BaseModel

from rest.schemas.common import PaginationMeta


class UserItem(BaseModel):
    """Single user with trace statistics."""

    user_id: str
    trace_count: int
    last_trace_time: datetime | None
    total_input_tokens: int | None = None
    total_output_tokens: int | None = None
    total_cost: float | None = None


class UserListResponse(BaseModel):
    """Paginated list of users."""

    data: list[UserItem]
    meta: PaginationMeta
