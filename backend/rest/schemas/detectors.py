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
    # False for rows written before the flag existed (reads default it).
    self_traced: bool = False
    # Signal assignment gave up on this hit after repeated unusable model
    # answers (an empty-signal signal_assignments row); listed per detector only.
    signal_gave_up: bool = False


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
    window are omitted; the frontend defaults absent entries to {0, 0}.

    ``distinct_finding_count`` is the number of *distinct* findings across the
    detectors counted (all of them, or just ``detector_ids`` when that scope is
    given). A finding is shared by every detector that fired on its trace, so it
    is not the sum of the per-detector ``finding_count`` values, which counts a
    shared finding once per detector.
    """

    data: dict[str, DetectorWindowSummary]
    distinct_finding_count: int = 0


class TraceCountsItem(BaseModel):
    """Traces in one local bucket."""

    # "YYYY-MM-DD" (day) or "YYYY-MM-DDTHH:00" (hour), in the request's `tz`.
    bucket: str
    count: int


class TraceCountsResponse(BaseModel):
    """Traces per bucket, ordered ascending. Empty buckets are omitted rather than
    zero-filled; callers that need a dense series fill the gaps themselves."""

    data: list[TraceCountsItem]
