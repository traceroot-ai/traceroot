"""Common API response schemas."""

from datetime import UTC, datetime
from typing import Annotated

from pydantic import AfterValidator, BaseModel


def as_utc(value: datetime) -> datetime:
    """Return ``value`` as an aware UTC datetime.

    Postgres ``timestamp without time zone`` and ClickHouse ``DateTime64`` columns
    come back as naive datetimes that are, by convention, already UTC. Serialized
    as-is they carry no offset (``2026-11-09T14:00:28.414000``), which is not a valid
    RFC 3339 ``date-time`` and is read as local time by most clients. A naive value
    is therefore *labelled* UTC (not shifted); an aware one is converted to UTC.
    """
    return value.replace(tzinfo=UTC) if value.tzinfo is None else value.astimezone(UTC)


# Use for response-model timestamp fields so the JSON always ends in ``Z``.
UtcDatetime = Annotated[datetime, AfterValidator(as_utc)]


class HealthResponse(BaseModel):
    """Health check response."""

    status: str


class PaginationMeta(BaseModel):
    """Pagination metadata for list responses."""

    page: int
    limit: int
    total: int
