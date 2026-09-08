"""Query-window presets shared by the widget query surfaces.

A widget query needs a time window. Interactive callers (the dashboard page,
the chat card previews) always send explicit bounds; the agent and the CLI
usually reason in the site's picker vocabulary instead — "last 7 days" — and
the model in particular never reliably knows the current time. So the query
surfaces accept either form, and this module is where a preset id becomes a
concrete window.

The table mirrors the UI's ``DATE_FILTER_OPTIONS`` (``frontend/ui/src/lib/
date-filter.ts``) id for id, minus ``custom`` — the one option with explicit
bounds, which callers express as ``start_time``/``end_time`` here. A frontend
parity test reads this file and fails if the two lists drift, and the default
is the same 24-hour window the site defaults to, so a chat that names no window
and a dashboard page that was never touched describe the same data.
"""

from datetime import UTC, datetime, timedelta

RANGE_PRESET_MINUTES: dict[str, int] = {
    "30m": 30,
    "1h": 60,
    "3h": 180,
    "6h": 360,
    "1d": 1440,
    "7d": 10080,
    "14d": 20160,
    "30d": 43200,
    "60d": 86400,
    "90d": 129600,
}

DEFAULT_RANGE_ID = "1d"


class WindowSpecError(ValueError):
    """A window the caller described cannot be resolved.

    Raised for an unknown preset id, a preset given alongside explicit bounds,
    one bound without the other, or an inverted pair. Routes map it to a 422 so
    a malformed window is a client error, never a scan.
    """


def as_utc(value: datetime) -> datetime:
    """Return ``value`` as an aware UTC datetime, treating a naive one as UTC.

    Args:
        value (datetime): Aware or naive; the retention cutoff is naive UTC.

    Returns:
        datetime: The same instant with ``UTC`` attached.
    """
    if value.tzinfo is None:
        return value.replace(tzinfo=UTC)
    return value.astimezone(UTC)


def resolve_window(
    range_id: str | None,
    start_time: datetime | None,
    end_time: datetime | None,
    *,
    now: datetime | None = None,
) -> tuple[datetime, datetime, str | None]:
    """Resolve a caller's window description to concrete UTC bounds.

    Args:
        range_id (str | None): A preset id from ``RANGE_PRESET_MINUTES``, or
            None to use explicit bounds (or, with none given, the default).
        start_time (datetime | None): Explicit lower bound; naive is read as UTC.
        end_time (datetime | None): Explicit upper bound; naive is read as UTC.
        now (datetime | None): The clock a preset is anchored to (tests inject
            one); defaults to the current UTC time.

    Returns:
        tuple[datetime, datetime, str | None]: ``(start, end, range_id)`` as
            aware UTC datetimes, with the preset id that produced them (the
            default's id when nothing was given) or None for explicit bounds.

    Raises:
        WindowSpecError: If both a preset and bounds were given, only one bound
            was given, the preset id is unknown, or the bounds are inverted.
    """
    has_bounds = start_time is not None or end_time is not None
    if range_id is not None and has_bounds:
        raise WindowSpecError("give either range or start_time/end_time, not both")
    if has_bounds:
        if start_time is None or end_time is None:
            raise WindowSpecError("both start_time and end_time are required together")
        start, end = as_utc(start_time), as_utc(end_time)
        if end <= start:
            raise WindowSpecError("end_time must be after start_time")
        return start, end, None

    resolved_id = DEFAULT_RANGE_ID if range_id is None else range_id
    minutes = RANGE_PRESET_MINUTES.get(resolved_id)
    if minutes is None:
        known = ", ".join(RANGE_PRESET_MINUTES)
        raise WindowSpecError(f"unknown range '{resolved_id}' (expected one of: {known})")
    end = as_utc(now) if now is not None else datetime.now(UTC)
    return end - timedelta(minutes=minutes), end, resolved_id
