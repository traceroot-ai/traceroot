from datetime import datetime, timezone


def ensure_utc_datetime(dt: datetime) -> datetime:
    """
    Ensure datetime object is timezone-aware and in UTC.

    Args:
        dt: datetime object (timezone-aware or naive)

    Returns:
        datetime object in UTC timezone
    """
    if dt.tzinfo is None:
        # If timezone-naive, assume UTC
        return dt.replace(tzinfo=timezone.utc)
    else:
        # If timezone-aware, convert to UTC
        return dt.astimezone(timezone.utc)
