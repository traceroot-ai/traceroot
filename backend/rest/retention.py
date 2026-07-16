"""Retention access-window gate.

Enforces plan-based data retention by restricting query time ranges.
Data is never deleted — only query access is restricted.

Plan-to-days mapping syncs with frontend/packages/core/src/ee/billing/plans.ts
ENTITLEMENT_CONFIG (15d/30d/90d/custom-retention).
"""

from datetime import UTC, datetime, timedelta

from fastapi import HTTPException, status

_PLAN_RETENTION_DAYS: dict[str, int | None] = {
    "free": 15,
    "starter": 30,
    "pro": 90,
    "enterprise": None,
}

_FAIL_CLOSED_DAYS = 15


def _to_naive_utc(dt: datetime) -> datetime:
    if dt.tzinfo is not None:
        return dt.astimezone(UTC).replace(tzinfo=None)
    return dt


def get_retention_cutoff(billing_plan: str) -> datetime | None:
    """Return the cutoff datetime (naive UTC) for a plan, or None if unlimited.

    Adds a 1-hour buffer so "Last N days" filters don't race against the
    server clock and falsely 403 at the exact boundary.
    """
    days = _PLAN_RETENTION_DAYS.get(billing_plan, _FAIL_CLOSED_DAYS)
    if days is None:
        return None
    return datetime.now(UTC).replace(tzinfo=None) - timedelta(days=days, hours=1)


def _retention_403(billing_plan: str, cutoff: datetime) -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_403_FORBIDDEN,
        detail={
            "message": "Data outside retention window",
            "retention_days": _PLAN_RETENTION_DAYS.get(billing_plan, _FAIL_CLOSED_DAYS),
            "cutoff": cutoff.isoformat(),
            "plan": billing_plan,
        },
    )


def clamp_retention_window(
    billing_plan: str,
    start_after: datetime | None,
    end_before: datetime | None = None,
) -> tuple[datetime | None, datetime | None]:
    """For session endpoints: clamp only, never 403.

    Sessions can span the retention boundary, so we silently clamp
    start_after to the cutoff instead of rejecting the request.
    """
    cutoff = get_retention_cutoff(billing_plan)
    if cutoff is None:
        return start_after, end_before

    if start_after is None or _to_naive_utc(start_after) < cutoff:
        start_after = cutoff

    return start_after, end_before


def enforce_retention_window(
    billing_plan: str,
    start_after: datetime | None,
    end_before: datetime | None = None,
) -> tuple[datetime | None, datetime | None]:
    """For list endpoints: clamp or 403 based on the plan's retention window.

    - Enterprise (unlimited): pass through unchanged.
    - start_after set and before cutoff: raise 403.
    - start_after unset: clamp to cutoff (default list view shows last N days).
    """
    cutoff = get_retention_cutoff(billing_plan)
    if cutoff is None:
        return start_after, end_before

    if start_after is not None and _to_naive_utc(start_after) < cutoff:
        raise _retention_403(billing_plan, cutoff)

    if start_after is None:
        start_after = cutoff

    return start_after, end_before


def enforce_retention_by_time(
    billing_plan: str,
    timestamp: datetime | None,
) -> None:
    """For by-id endpoints: 403 if the resource's timestamp is outside the window."""
    cutoff = get_retention_cutoff(billing_plan)
    if cutoff is None:
        return
    if timestamp is not None and _to_naive_utc(timestamp) < cutoff:
        raise _retention_403(billing_plan, cutoff)
