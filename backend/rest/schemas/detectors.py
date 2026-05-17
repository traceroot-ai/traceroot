"""Detector finding/run response schemas."""

from datetime import datetime

from pydantic import BaseModel

from rest.schemas.common import PaginationMeta


class FindingItem(BaseModel):
    """Single detector finding row."""

    finding_id: str
    project_id: str
    trace_id: str
    summary: str
    payload: str
    timestamp: datetime


class FindingListResponse(BaseModel):
    """Paginated list of findings."""

    data: list[FindingItem]
    meta: PaginationMeta


class RunItem(BaseModel):
    """Single detector run row, optionally joined with its finding's per-detector summary."""

    run_id: str
    detector_id: str
    project_id: str
    trace_id: str
    finding_id: str | None
    status: str
    timestamp: datetime
    summary: str


class RunListResponse(BaseModel):
    """Paginated list of runs."""

    data: list[RunItem]
    meta: PaginationMeta


class DetectorCountsItem(BaseModel):
    """Aggregated counts for a single detector over a time window."""

    finding_count: int
    run_count: int


class DetectorCountsResponse(BaseModel):
    """Map of detector_id -> counts. Detectors with zero runs in the window
    are omitted; the frontend defaults absent entries to {0, 0}."""

    data: dict[str, DetectorCountsItem]
