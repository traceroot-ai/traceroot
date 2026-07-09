"""Static field registry for the widget query engine.

Declares which views and fields widget specs may reference. The compiler
(`widget_query.py`) refuses anything not declared here, so this file is the
single source of truth for what dashboard widgets can query. Field `expr`s
reference aliases produced by each view's base relation (see `base_sql`),
never raw user input.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Literal

FILTER_OPS_STRING = ("=", "!=", "contains")
FILTER_OPS_NUMBER = (">", ">=", "<", "<=", "=", "!=")
AGGS_NUMBER = ("sum", "avg", "min", "max", "p50", "p95", "p99")


@dataclass(frozen=True)
class FieldDef:
    expr: str  # SQL over the view's base relation aliases
    type: Literal["string", "number"]
    label: str
    # filterOps: camelCase deliberate — this dict is the JSON contract consumed
    # directly by the frontend builder UI.
    filter_ops: tuple[str, ...] = ()
    groupable: bool = False
    aggs: tuple[str, ...] = ()


@dataclass(frozen=True)
class ViewDef:
    # Base relation: deduped (ReplacingMergeTree → LIMIT 1 BY) and ALWAYS
    # scoped by {project_id}/{start_time}/{end_time} parameters. Exposes a
    # stable `event_time` alias used for time bucketing.
    base_sql: str
    fields: dict[str, FieldDef] = field(default_factory=dict)


_SPANS_BASE = """
    SELECT
        name, span_kind, status, model_name, environment,
        span_start_time AS event_time,
        dateDiff('millisecond', span_start_time, span_end_time) AS duration_ms,
        cost, input_tokens, output_tokens, total_tokens
    FROM (
        SELECT
            span_id, trace_id, name, span_kind, status, model_name, environment,
            span_start_time, span_end_time, cost, input_tokens, output_tokens, total_tokens
        FROM spans
        WHERE project_id = {project_id:String}
          AND span_start_time >= {start_time:DateTime64(3)}
          AND span_start_time < {end_time:DateTime64(3)}
        ORDER BY ch_update_time DESC
        LIMIT 1 BY project_id, trace_id, span_id
    )
"""

# Trace-level metrics do not exist as physical columns; they are aggregated
# from spans per trace. The spans subquery is bounded by the same dashboard
# time window as the traces query, so a trace whose spans extend beyond the
# window edge will have those later spans excluded. This means duration,
# cost, and token counts here may differ from the per-trace detail page (which
# joins all spans for a trace). The tradeoff is a bounded, fast scan for
# dashboards vs. exact per-trace metrics in the trace list.
_TRACES_BASE = """
    SELECT
        t.name AS name, t.user_id AS user_id,
        t.session_id AS session_id, t.environment AS environment,
        t.trace_start_time AS event_time,
        -- NULL out measures for non-matched LEFT JOIN rows; ClickHouse fills
        -- String join key columns with '' (empty string) when there is no match,
        -- so sa.trace_id = '' reliably identifies un-joined traces.
        if(sa.trace_id = '', NULL, sa.duration_ms) AS duration_ms,
        if(sa.trace_id = '', NULL, sa.error_count) AS error_count,
        if(sa.trace_id = '', NULL, sa.total_cost) AS cost,
        if(sa.trace_id = '', NULL, sa.input_tokens) AS input_tokens,
        if(sa.trace_id = '', NULL, sa.output_tokens) AS output_tokens,
        if(sa.trace_id = '', NULL, sa.total_tokens) AS total_tokens
    FROM (
        SELECT
            trace_id, name, user_id, session_id, environment, trace_start_time
        FROM traces
        WHERE project_id = {project_id:String}
          AND trace_start_time >= {start_time:DateTime64(3)}
          AND trace_start_time < {end_time:DateTime64(3)}
        ORDER BY ch_update_time DESC
        LIMIT 1 BY project_id, trace_id
    ) AS t
    LEFT JOIN (
        SELECT
            trace_id,
            if(
                min(span_start_time) IS NOT NULL AND max(span_end_time) IS NOT NULL,
                dateDiff('millisecond', min(span_start_time), max(span_end_time)),
                NULL
            ) AS duration_ms,
            countIf(status = 'ERROR') AS error_count,
            sum(cost) AS total_cost,
            sum(input_tokens) AS input_tokens,
            sum(output_tokens) AS output_tokens,
            sum(total_tokens) AS total_tokens
        FROM (
            SELECT
                trace_id, span_id, status, span_start_time, span_end_time, cost,
                input_tokens, output_tokens, total_tokens
            FROM spans
            WHERE project_id = {project_id:String}
              AND span_start_time >= {start_time:DateTime64(3)}
              AND span_start_time < {end_time:DateTime64(3)}
            ORDER BY ch_update_time DESC
            LIMIT 1 BY project_id, trace_id, span_id
        )
        GROUP BY trace_id
    ) AS sa ON sa.trace_id = t.trace_id
"""


def _string_dim(expr: str, label: str) -> FieldDef:
    return FieldDef(
        expr=expr,
        type="string",
        label=label,
        filter_ops=FILTER_OPS_STRING,
        groupable=True,
    )


def _number_measure(expr: str, label: str) -> FieldDef:
    return FieldDef(
        expr=expr,
        type="number",
        label=label,
        filter_ops=FILTER_OPS_NUMBER,
        aggs=AGGS_NUMBER,
    )


REGISTRY: dict[str, ViewDef] = {
    "spans": ViewDef(
        base_sql=_SPANS_BASE,
        fields={
            "name": _string_dim("name", "Span name"),
            "span_kind": _string_dim("span_kind", "Span kind"),
            # Effectively binary (OK / ERROR): useful as a filter, not worth a
            # breakdown dimension.
            "status": FieldDef(
                expr="status", type="string", label="Status", filter_ops=FILTER_OPS_STRING
            ),
            "model_name": _string_dim("model_name", "Model"),
            "environment": _string_dim("environment", "Environment"),
            # Labels follow the trace-list filter vocabulary (see
            # rest.services.filters.columns); units surface as input adornments
            # in the builder, not in the label.
            "duration_ms": _number_measure("duration_ms", "Duration"),
            "cost": _number_measure("cost", "Cost"),
            "input_tokens": _number_measure("input_tokens", "Input tokens"),
            "output_tokens": _number_measure("output_tokens", "Output tokens"),
            "total_tokens": _number_measure("total_tokens", "Total tokens"),
            # expr="*" is a sentinel: the compiler translates it to count(*).
            "count": FieldDef(expr="*", type="number", label="Count", aggs=("count",)),
        },
    ),
    "traces": ViewDef(
        base_sql=_TRACES_BASE,
        fields={
            "name": _string_dim("name", "Trace name"),
            "user_id": _string_dim("user_id", "User"),
            "session_id": _string_dim("session_id", "Session"),
            "environment": _string_dim("environment", "Environment"),
            # Same quantities the trace list exposes — same words (Latency,
            # Cost, Tokens, Errors), so filtering a widget reads like
            # filtering the trace list.
            "duration_ms": _number_measure("duration_ms", "Latency"),
            "cost": _number_measure("cost", "Cost"),
            "input_tokens": _number_measure("input_tokens", "Input tokens"),
            "output_tokens": _number_measure("output_tokens", "Output tokens"),
            "total_tokens": _number_measure("total_tokens", "Tokens"),
            # expr="*" is a sentinel: the compiler translates it to count(*).
            "count": FieldDef(expr="*", type="number", label="Count", aggs=("count",)),
            # Last, so the list reads as the spans measures plus one trailing
            # trace-only addition when switching views.
            "error_count": _number_measure("error_count", "Errors"),
        },
    ),
}


def registry_schema() -> dict:
    """JSON-friendly registry for `GET /widgets/schema`. Omits SQL exprs."""
    return {
        view_name: {
            "fields": {
                fname: {
                    "type": f.type,
                    "label": f.label,
                    "filterOps": list(f.filter_ops),
                    "groupable": f.groupable,
                    "aggs": list(f.aggs),
                }
                for fname, f in view.fields.items()
            }
        }
        for view_name, view in REGISTRY.items()
    }
