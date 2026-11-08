"""Window aggregates for the background update.

The update compares one window of a project's traffic with the window before
it. Every number it reports comes from here, computed in ClickHouse for the
whole window and never sampled; the worker computes the differences in code.

One call returns one window. All reads are limited to customer traffic
(``source = 'user'`` and not an evaluation), scoped by project and time, and
capped in execution time, so a call cannot scan beyond its window.
"""

from datetime import datetime
from decimal import Decimal
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel

from db.clickhouse.client import get_clickhouse_client
from rest.routers.internal.auth import verify_internal_secret
from rest.sql_utils import to_utc_naive

router = APIRouter(prefix="/update-aggregates")

# A window is a day or a week plus a daylight-saving hour; anything longer is a bug.
MAX_WINDOW_DAYS = 9
QUERY_TIMEOUT_SECONDS = 20
# Distinct models, tools, workflows and refs returned; the rest are not reported.
MAX_ENTITIES = 50

_TRAFFIC = "source = 'user' AND is_evaluation = 0"

# One row per trace in the window: whether any span failed, how long the root
# span ran, and the trace's name and ref. Everything below aggregates this.
_PER_TRACE = f"""
    SELECT s.trace_id AS trace_id, s.failed AS failed, s.duration_ms AS duration_ms,
           t.name AS name, t.git_ref AS git_ref
    FROM (
        SELECT trace_id,
               max(status = 'ERROR') AS failed,
               maxIf(dateDiff('millisecond', span_start_time, span_end_time),
                     parent_span_id IS NULL) AS duration_ms
        FROM spans
        WHERE project_id = {{project_id:String}}
          AND span_start_time >= {{start:DateTime64(3)}} AND span_start_time < {{end:DateTime64(3)}}
          AND {_TRAFFIC}
        GROUP BY trace_id
    ) AS s
    INNER JOIN (
        SELECT trace_id, name, git_ref
        FROM traces
        WHERE project_id = {{project_id:String}}
          AND trace_start_time >= {{start:DateTime64(3)}} AND trace_start_time < {{end:DateTime64(3)}}
          AND {_TRAFFIC}
    ) AS t ON s.trace_id = t.trace_id
"""

_SPANS_IN_WINDOW = f"""
    project_id = {{project_id:String}}
    AND span_start_time >= {{start:DateTime64(3)}} AND span_start_time < {{end:DateTime64(3)}}
    AND {_TRAFFIC}
"""


class Totals(BaseModel):
    traces: int
    error_traces: int
    p50_ms: int
    p95_ms: int
    p99_ms: int
    git_context_traces: int


class LlmTotals(BaseModel):
    calls: int
    input_tokens: int
    output_tokens: int
    total_tokens: int
    cost: str


class ModelRow(BaseModel):
    model: str
    calls: int
    total_tokens: int
    cost: str


class ModelDayRow(BaseModel):
    model: str
    day: str
    total_tokens: int
    cost: str


class ToolRow(BaseModel):
    name: str
    calls: int
    errors: int


class GroupRow(BaseModel):
    name: str
    traces: int
    error_traces: int
    p50_ms: int
    p95_ms: int


class UpdateAggregates(BaseModel):
    start: datetime
    end: datetime
    totals: Totals
    llm: LlmTotals
    by_model: list[ModelRow]
    by_model_day: list[ModelDayRow]
    tools: list[ToolRow]
    workflows: list[GroupRow]
    refs: list[GroupRow]


def _ms(value: Any) -> int:
    """A latency percentile as whole milliseconds; an empty set gives NaN or NULL, which is 0."""
    if value is None or value != value:
        return 0
    return int(value)


def _cost(value: Any) -> str:
    return format(Decimal(value or 0), "f")


def _rows(ch: Any, sql: str, params: dict[str, Any]) -> list[tuple]:
    result = ch.query(
        sql, parameters=params, settings={"max_execution_time": QUERY_TIMEOUT_SECONDS}
    )
    return list(result.result_rows)


@router.get(
    "",
    response_model=UpdateAggregates,
    dependencies=[Depends(verify_internal_secret)],
)
def get_update_aggregates(
    project_id: str,
    start: datetime = Query(..., description="Window start (inclusive)"),
    end: datetime = Query(..., description="Window end (exclusive)"),
) -> UpdateAggregates:
    """Counts, rates, latency percentiles, tokens and cost for one window."""
    start_utc, end_utc = to_utc_naive(start), to_utc_naive(end)
    if end_utc <= start_utc:
        raise HTTPException(status_code=422, detail="end must be after start")
    if (end_utc - start_utc).days > MAX_WINDOW_DAYS:
        raise HTTPException(status_code=422, detail=f"window longer than {MAX_WINDOW_DAYS} days")

    ch = get_clickhouse_client()
    params = {"project_id": project_id, "start": start_utc, "end": end_utc}

    ((traces, failed, p50, p95, p99, with_ref),) = _rows(
        ch,
        f"""
        SELECT count(), countIf(failed), quantileExact(0.5)(duration_ms),
               quantileExact(0.95)(duration_ms), quantileExact(0.99)(duration_ms),
               countIf(git_ref IS NOT NULL AND git_ref != '')
        FROM ({_PER_TRACE})
        """,
        params,
    )

    ((calls, tokens_in, tokens_out, tokens_total, cost),) = _rows(
        ch,
        f"""
        SELECT count(), sum(input_tokens), sum(output_tokens), sum(total_tokens), sum(cost)
        FROM spans WHERE {_SPANS_IN_WINDOW} AND span_kind = 'LLM'
        """,
        params,
    )

    by_model = _rows(
        ch,
        f"""
        SELECT model_name, count(), sum(total_tokens), sum(cost)
        FROM spans WHERE {_SPANS_IN_WINDOW} AND span_kind = 'LLM' AND model_name IS NOT NULL
        GROUP BY model_name ORDER BY sum(cost) DESC, model_name LIMIT {MAX_ENTITIES}
        """,
        params,
    )

    by_model_day = _rows(
        ch,
        f"""
        SELECT model_name, toString(toDate(span_start_time)) AS day, sum(total_tokens), sum(cost)
        FROM spans WHERE {_SPANS_IN_WINDOW} AND span_kind = 'LLM' AND model_name IS NOT NULL
        GROUP BY model_name, day ORDER BY model_name, day LIMIT {MAX_ENTITIES * 10}
        """,
        params,
    )

    tools = _rows(
        ch,
        f"""
        SELECT name, count(), countIf(status = 'ERROR')
        FROM spans WHERE {_SPANS_IN_WINDOW} AND span_kind = 'TOOL'
        GROUP BY name ORDER BY count() DESC, name LIMIT {MAX_ENTITIES}
        """,
        params,
    )

    workflows = _rows(
        ch,
        f"""
        SELECT name, count(), countIf(failed), quantileExact(0.5)(duration_ms),
               quantileExact(0.95)(duration_ms)
        FROM ({_PER_TRACE}) GROUP BY name ORDER BY count() DESC, name LIMIT {MAX_ENTITIES}
        """,
        params,
    )

    refs = _rows(
        ch,
        f"""
        SELECT git_ref, count(), countIf(failed), quantileExact(0.5)(duration_ms),
               quantileExact(0.95)(duration_ms)
        FROM ({_PER_TRACE}) WHERE git_ref IS NOT NULL AND git_ref != ''
        GROUP BY git_ref ORDER BY count() DESC, git_ref LIMIT {MAX_ENTITIES}
        """,
        params,
    )

    return UpdateAggregates(
        start=start_utc,
        end=end_utc,
        totals=Totals(
            traces=traces,
            error_traces=failed,
            p50_ms=_ms(p50),
            p95_ms=_ms(p95),
            p99_ms=_ms(p99),
            git_context_traces=with_ref,
        ),
        llm=LlmTotals(
            calls=calls,
            input_tokens=int(tokens_in or 0),
            output_tokens=int(tokens_out or 0),
            total_tokens=int(tokens_total or 0),
            cost=_cost(cost),
        ),
        by_model=[
            ModelRow(model=m, calls=c, total_tokens=int(t or 0), cost=_cost(k))
            for m, c, t, k in by_model
        ],
        by_model_day=[
            ModelDayRow(model=m, day=d, total_tokens=int(t or 0), cost=_cost(k))
            for m, d, t, k in by_model_day
        ],
        tools=[ToolRow(name=n, calls=c, errors=e) for n, c, e in tools],
        workflows=[
            GroupRow(name=n, traces=c, error_traces=e, p50_ms=_ms(a), p95_ms=_ms(b))
            for n, c, e, a, b in workflows
        ],
        refs=[
            GroupRow(name=n, traces=c, error_traces=e, p50_ms=_ms(a), p95_ms=_ms(b))
            for n, c, e, a, b in refs
        ],
    )


# --- sample -----------------------------------------------------------------

# A fixed sample, not customisable: failures first, then the slowest and the
# costliest, then a seeded random remainder. It explains the numbers and is
# always labelled a sample; it never measures them.
SAMPLE_FAILURES = 8
SAMPLE_SLOWEST = 4
SAMPLE_COSTLIEST = 4
SAMPLE_RANDOM = 4


class SampleTrace(BaseModel):
    trace_id: str
    name: str
    reason: str
    failed: bool
    duration_ms: int
    cost: str
    git_ref: str | None


class UpdateSample(BaseModel):
    is_sample: bool = True
    traces: list[SampleTrace]


_SAMPLE_BASE = f"""
    SELECT per.trace_id AS trace_id, per.name AS name, per.failed AS failed,
           per.duration_ms AS duration_ms, per.git_ref AS git_ref, ifNull(c.cost, 0) AS cost
    FROM ({_PER_TRACE.replace("s.trace_id AS trace_id", "s.trace_id AS trace_id")}) AS per
    LEFT JOIN (
        SELECT trace_id, sum(cost) AS cost
        FROM spans WHERE {_SPANS_IN_WINDOW} AND span_kind = 'LLM'
        GROUP BY trace_id
    ) AS c ON per.trace_id = c.trace_id
"""


@router.get(
    "/sample",
    response_model=UpdateSample,
    dependencies=[Depends(verify_internal_secret)],
)
def get_update_sample(
    project_id: str,
    start: datetime = Query(...),
    end: datetime = Query(...),
    seed: int = Query(0, ge=0, le=2**31),
) -> UpdateSample:
    """A small labelled sample of traces for qualitative drill-down; no inputs or outputs."""
    start_utc, end_utc = to_utc_naive(start), to_utc_naive(end)
    if end_utc <= start_utc or (end_utc - start_utc).days > MAX_WINDOW_DAYS:
        raise HTTPException(status_code=422, detail="invalid window")
    ch = get_clickhouse_client()
    params = {"project_id": project_id, "start": start_utc, "end": end_utc, "seed": seed}
    parts = [
        ("failure", "failed = 1", "trace_id DESC", SAMPLE_FAILURES),
        ("slowest", "1", "duration_ms DESC, trace_id", SAMPLE_SLOWEST),
        ("costliest", "1", "cost DESC, trace_id", SAMPLE_COSTLIEST),
        ("random", "1", "cityHash64(trace_id, {seed:UInt32}), trace_id", SAMPLE_RANDOM),
    ]
    chosen: dict[str, SampleTrace] = {}
    for reason, condition, order, limit in parts:
        rows = _rows(
            ch,
            f"SELECT trace_id, name, failed, duration_ms, cost, git_ref FROM ({_SAMPLE_BASE}) "
            f"WHERE {condition} ORDER BY {order} LIMIT {limit + len(chosen)}",
            params,
        )
        taken = 0
        for trace_id, name, failed, duration, cost, git_ref in rows:
            if trace_id in chosen or taken >= limit:
                continue
            chosen[trace_id] = SampleTrace(
                trace_id=trace_id,
                name=name,
                reason=reason,
                failed=bool(failed),
                duration_ms=_ms(duration),
                cost=_cost(cost),
                git_ref=git_ref or None,
            )
            taken += 1
    return UpdateSample(traces=list(chosen.values()))
