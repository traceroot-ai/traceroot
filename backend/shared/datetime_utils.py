"""Shared datetime helpers used by REST and worker code."""

from datetime import UTC, datetime


def to_utc_aware(dt: datetime) -> datetime:
    """Treat naive datetimes as UTC (ClickHouse/OTEL store naive UTC); normalize
    aware datetimes to UTC. Output therefore always carries +00:00 on isoformat().
    """
    return dt.replace(tzinfo=UTC) if dt.tzinfo is None else dt.astimezone(UTC)
