"""Shared helpers for building ClickHouse parameterized queries.

These are cross-module utilities — both `services/trace_reader.py` and
`routers/internal.py` rely on them, so the helpers live in a feature-neutral
spot rather than as private symbols inside any one caller.
"""

from datetime import UTC, datetime


def to_utc_naive(dt: datetime) -> datetime:
    """Convert datetime to UTC naive datetime for ClickHouse comparison.

    ClickHouse `DateTime64` parameters expect timezone-naive values; FastAPI's
    auto-parser hands us aware values when the client passes an offset/Z suffix.
    Drop the offset after normalizing to UTC.
    """
    if dt.tzinfo is not None:
        return dt.astimezone(UTC).replace(tzinfo=None)
    return dt


def escape_ilike(value: str) -> str:
    """Escape ClickHouse ILIKE wildcards (`%`, `_`) plus the escape char itself.

    ClickHouse ILIKE treats `%` and `_` as wildcards and uses backslash as the
    default escape character. Wrapping user input through this function makes
    those characters match literally instead — e.g. searching for "100%" hits
    rows literally containing "100%", not every row containing "100".
    """
    return value.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
