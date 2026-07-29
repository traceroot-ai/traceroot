"""Detector finding/run response schemas."""

from datetime import datetime

from pydantic import BaseModel

from rest.schemas.common import PaginationMeta


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


class DetectorWindowSummary(BaseModel):
    """Per-detector rollup for a time window: counts plus a few sample traces."""

    finding_count: int
    run_count: int
    # Representative traces for this detector's window, newest-first; empty when
    # it never fired. Plural + sample-shaped so we can surface more than one
    # later (a SQL-only change) without touching this contract — and so the
    # digest gets its deep-link target without a second per-detector read.
    sample_trace_ids: list[str] = []
    # Recent per-detector judge summaries (newest-first, capped in SQL), only
    # populated when the request sets include_summaries=true. Feeds the digest
    # LLM summary; empty otherwise.
    sample_summaries: list[str] = []


class DetectorWindowSummaryResponse(BaseModel):
    """Map of detector_id -> window summary. Detectors with zero runs in the
    window are omitted; the frontend defaults absent entries to {0, 0}."""

    data: dict[str, DetectorWindowSummary]
