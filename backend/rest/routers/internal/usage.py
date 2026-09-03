"""Usage metering reads for billing."""

from datetime import datetime

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel

from db.clickhouse.client import get_clickhouse_client
from rest.routers.internal.auth import verify_internal_secret
from rest.sql_utils import to_utc_naive

router = APIRouter()


class UsageTotalResponse(BaseModel):
    total_events: int


class SourceCount(BaseModel):
    traces: int = 0
    spans: int = 0


class UsageDetailsResponse(BaseModel):
    traces: int
    spans: int
    detector_runs: int = 0
    # Attribution/display only: splits the same rows by writer so the billing
    # tab can show customers which rows are theirs. The Free ingestion cap,
    # quota notifier and Stripe quantity all read the unfiltered totals above
    # (every stored row, whoever wrote it — 747562e2).
    by_source: dict[str, SourceCount] = {}


def _empty_breakdown() -> dict[str, SourceCount]:
    # Always seed all three buckets so every response has the same shape and
    # consumers can index a bucket before its first row exists.
    return {s: SourceCount() for s in ("user", "detector", "agent")}


@router.get(
    "/usage/total",
    response_model=UsageTotalResponse,
    dependencies=[Depends(verify_internal_secret)],
)
async def get_usage_total(
    project_ids: str = Query(..., description="Comma-separated list of project IDs"),
    start: datetime = Query(..., description="Start of interval (ISO format)"),
    end: datetime = Query(..., description="End of interval (ISO format)"),
) -> UsageTotalResponse:
    """Get total usage for specific projects in a time interval."""
    project_id_list = [p.strip() for p in project_ids.split(",") if p.strip()]

    if not project_id_list:
        return UsageTotalResponse(total_events=0)

    ch = get_clickhouse_client()

    # Format datetime without timezone for ClickHouse
    start_str = to_utc_naive(start).strftime("%Y-%m-%d %H:%M:%S")
    end_str = to_utc_naive(end).strftime("%Y-%m-%d %H:%M:%S")

    # ReplacingMergeTree dedup via uniqExact — same trace/span id can have
    # multiple pre-merge rows in ClickHouse.
    result = ch.query(
        """
        SELECT (
            (SELECT uniqExact(trace_id) FROM traces
             WHERE project_id IN {project_ids:Array(String)}
               AND ch_create_time >= {start:String}
               AND ch_create_time < {end:String})
          + (SELECT uniqExact(span_id) FROM spans
             WHERE project_id IN {project_ids:Array(String)}
               AND ch_create_time >= {start:String}
               AND ch_create_time < {end:String})
        ) as total
        """,
        parameters={
            "project_ids": project_id_list,
            "start": start_str,
            "end": end_str,
        },
    )

    total = int(result.result_rows[0][0]) if result.result_rows else 0
    return UsageTotalResponse(total_events=total)


@router.get(
    "/usage/details",
    response_model=UsageDetailsResponse,
    dependencies=[Depends(verify_internal_secret)],
)
async def get_usage_details(
    project_ids: str = Query(..., description="Comma-separated list of project IDs"),
    start: datetime = Query(..., description="Start of interval (ISO format)"),
    end: datetime = Query(..., description="End of interval (ISO format)"),
) -> UsageDetailsResponse:
    """Get detailed usage (traces and spans separately) for specific projects."""
    project_id_list = [p.strip() for p in project_ids.split(",") if p.strip()]

    if not project_id_list:
        return UsageDetailsResponse(
            traces=0, spans=0, detector_runs=0, by_source=_empty_breakdown()
        )

    ch = get_clickhouse_client()

    # Format datetime without timezone for ClickHouse
    start_str = to_utc_naive(start).strftime("%Y-%m-%d %H:%M:%S")
    end_str = to_utc_naive(end).strftime("%Y-%m-%d %H:%M:%S")

    # Query traces count — uniqExact dedups across pre-merge ReplacingMergeTree
    # rows (a single trace can have multiple rows until background merge runs,
    # e.g. on status update). uniqExact is faster than count(DISTINCT trace_id)
    # in ClickHouse and produces identical results.
    traces_result = ch.query(
        """
        SELECT uniqExact(trace_id) as total
        FROM traces
        WHERE project_id IN {project_ids:Array(String)}
          AND ch_create_time >= {start:String}
          AND ch_create_time < {end:String}
        """,
        parameters={
            "project_ids": project_id_list,
            "start": start_str,
            "end": end_str,
        },
    )

    # Query spans count — same uniqExact pattern for ReplacingMergeTree dedup
    spans_result = ch.query(
        """
        SELECT uniqExact(span_id) as total
        FROM spans
        WHERE project_id IN {project_ids:Array(String)}
          AND ch_create_time >= {start:String}
          AND ch_create_time < {end:String}
        """,
        parameters={
            "project_ids": project_id_list,
            "start": start_str,
            "end": end_str,
        },
    )

    traces = int(traces_result.result_rows[0][0]) if traces_result.result_rows else 0
    spans = int(spans_result.result_rows[0][0]) if spans_result.result_rows else 0

    # Detector runs: count every scan attempt recorded by the detector worker
    # (BYOK + system source both count toward Free-plan hard cap).
    # uniqExact on run_id dedups pre-merge duplicates in the ReplacingMergeTree —
    # same pattern as the traces / spans queries above.
    detector_runs_result = ch.query(
        """
        SELECT uniqExact(run_id) as total
        FROM detector_runs
        WHERE project_id IN {project_ids:Array(String)}
          AND timestamp >= {start:String}
          AND timestamp < {end:String}
        """,
        parameters={
            "project_ids": project_id_list,
            "start": start_str,
            "end": end_str,
        },
    )
    detector_runs = (
        int(detector_runs_result.result_rows[0][0]) if detector_runs_result.result_rows else 0
    )

    # Breakdown is a separate query so the total queries above stay byte-for-byte
    # unfiltered (their guard test asserts no `source` token). Same dedup as the
    # totals: uniqExact per source over pre-merge ReplacingMergeTree rows.
    breakdown_result = ch.query(
        """
        SELECT source, uniqExact(trace_id) AS traces, 0 AS spans
        FROM traces
        WHERE project_id IN {project_ids:Array(String)}
          AND ch_create_time >= {start:String}
          AND ch_create_time < {end:String}
        GROUP BY source
        UNION ALL
        SELECT source, 0 AS traces, uniqExact(span_id) AS spans
        FROM spans
        WHERE project_id IN {project_ids:Array(String)}
          AND ch_create_time >= {start:String}
          AND ch_create_time < {end:String}
        GROUP BY source
        """,
        parameters={"project_ids": project_id_list, "start": start_str, "end": end_str},
    )
    by_source = _empty_breakdown()
    for source, t, s in breakdown_result.result_rows:
        bucket = by_source.setdefault(str(source), SourceCount())
        bucket.traces += int(t)
        bucket.spans += int(s)

    return UsageDetailsResponse(
        traces=traces, spans=spans, detector_runs=detector_runs, by_source=by_source
    )
