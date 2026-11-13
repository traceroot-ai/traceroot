"""Datetime normalization shared by storage and query code."""

from datetime import UTC, datetime


def to_utc_naive(dt: datetime) -> datetime:
    """Normalize an aware datetime to UTC, leaving a naive UTC value unchanged.

    Args:
        dt (datetime): An aware instant or an existing naive UTC value.

    Returns:
        datetime: The instant represented as naive UTC.
    """
    if dt.tzinfo is not None:
        return dt.astimezone(UTC).replace(tzinfo=None)
    return dt
