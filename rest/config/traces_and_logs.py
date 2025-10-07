"""
Traces and logs tracking configuration models.
"""

from datetime import datetime, timezone
from typing import Optional

from pydantic import BaseModel, field_validator


class GetTracesAndLogsSinceDateRequest(BaseModel):
    """Request model for getting traces and logs since a specific date."""
    since_date: datetime
    trace_provider: str = "aws"
    log_provider: str = "aws"
    trace_region: str | None = None
    log_region: str | None = None

    @field_validator('since_date')
    @classmethod
    def ensure_utc_timezone(cls, v: datetime) -> datetime:
        """Ensure datetime is timezone-aware and in UTC."""
        if v.tzinfo is None:
            # If timezone-naive, assume UTC
            return v.replace(tzinfo=timezone.utc)
        else:
            # If timezone-aware, convert to UTC
            return v.astimezone(timezone.utc)


class TracesAndLogsStatistics(BaseModel):
    """Statistics for traces and logs usage."""

    customer_id: str
    last_payment_date: str
    current_date: str
    days_since_payment: int
    trace_count: int
    log_count: int
    trace__log: int  # Total traces and logs (matches Autumn feature ID)
    period_start: str
    period_end: str
    error: Optional[str] = None


class GetTracesAndLogsSinceDateResponse(BaseModel):
    """Response model for traces and logs statistics."""
    traces_and_logs: TracesAndLogsStatistics
