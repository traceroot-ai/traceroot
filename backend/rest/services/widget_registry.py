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

from rest.services.trace_reader import customer_traffic_only

FILTER_OPS_STRING = ("=", "contains")
FILTER_OPS_NUMBER = (">", ">=", "<", "<=", "=")
AGGS_NUMBER = ("sum", "avg", "min", "max", "p50", "p75", "p90", "p95", "p99", "uniq")

# What the builder offers on a numeric measure; alerts reach the wider
# AGGS_NUMBER set. The same fields serve both, so the audiences can only be told
# apart at the projection, never per field.
BUILDER_AGGS_NUMBER = ("sum", "avg", "min", "max", "p50", "p95", "p99")


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
    # ``expr`` names a Map column rather than a scalar, so a keyed field can be
    # filtered but never grouped, aggregated or enumerated. Mirrors ``requires_key``
    # in rest.services.filters.columns.
    requires_key: bool = False
    # The builder derives its dropdowns from every entry in the schema response, so
    # a field added for alerts would otherwise surface as a new dashboard option.
    # `builder_aggs` is the same split per aggregation, None meaning "same as aggs".
    in_builder: bool = True
    builder_aggs: tuple[str, ...] | None = None


@dataclass(frozen=True)
class ViewDef:
    # Base relation: deduped (ReplacingMergeTree → LIMIT 1 BY) and ALWAYS
    # scoped by {project_id}/{start_time}/{end_time} parameters. Exposes a
    # stable `event_time` alias used for time bucketing.
    base_sql: str
    fields: dict[str, FieldDef] = field(default_factory=dict)


# Preserve NULL when cache token data was never reported.
_CACHE_READ_TOKENS_EXPR = (
    "if(mapContains(usage_details, 'cache_read_tokens'), usage_details['cache_read_tokens'], NULL)"
)
_CACHE_WRITE_TOKENS_EXPR = "if(mapContains(usage_details, 'cache_write_tokens'), usage_details['cache_write_tokens'], NULL)"

# Over the physical column, not an alias, so the one declaration resolves both
# against the spans base relation and against the raw `spans` table in the
# distinct-values scan. 'true'/'false' rather than 1/0 gives the filter builders a
# two-option dropdown. The OTEL transform normalizes a zero-filled parent id to
# NULL, so the IS NULL test holds at ingest.
_IS_ROOT_EXPR = "if(parent_span_id IS NULL, 'true', 'false')"

# Where a base relation splices in the columns only a keyed filter reads, written
# as a SQL line comment so an unspliced relation is byte-for-byte today's query.
# `metadata_map` is the one column the spans no-I/O projection lacks (migration
# 009), so naming it unconditionally would drop every widget query off that
# projection and lose the time pruning. A metadata filter pays that; nothing else.
KEYED_COLUMN_SLOT = "--keyed-columns"

# The same column the trace-list translator filters through, so the two engines
# ask the same question of the same data.
METADATA_MAP_COLUMN = "metadata_map"


_SPANS_BASE = f"""
    SELECT
        name, span_kind, status, model_name, environment, trace_id,
        parent_span_id, {_IS_ROOT_EXPR} AS is_root,
        span_start_time AS event_time,
        dateDiff('millisecond', span_start_time, span_end_time) AS duration_ms,
        cost, input_tokens, output_tokens, total_tokens,
        if(duration_ms > 0, total_tokens * 1000 / duration_ms, NULL) AS tokens_per_second,
        {_CACHE_READ_TOKENS_EXPR} AS cache_read_tokens,
        {_CACHE_WRITE_TOKENS_EXPR} AS cache_write_tokens
        {KEYED_COLUMN_SLOT}
    FROM (
        SELECT
            span_id, trace_id, parent_span_id, name, span_kind, status, model_name, environment,
            span_start_time, span_end_time, cost, input_tokens, output_tokens, total_tokens, usage_details
            {KEYED_COLUMN_SLOT}
        FROM spans
        WHERE project_id = {{project_id:String}}
          AND {customer_traffic_only()}
          AND span_start_time >= {{start_time:DateTime64(3)}}
          AND span_start_time < {{end_time:DateTime64(3)}}
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
_TRACES_BASE = f"""
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
        if(sa.trace_id = '', NULL, sa.total_tokens) AS total_tokens,
        if(sa.trace_id = '', NULL, sa.cache_read_tokens) AS cache_read_tokens,
        if(sa.trace_id = '', NULL, sa.cache_write_tokens) AS cache_write_tokens
    FROM (
        SELECT
            trace_id, name, user_id, session_id, environment, trace_start_time
        FROM traces
        WHERE project_id = {{project_id:String}}
          AND {customer_traffic_only()}
          AND trace_start_time >= {{start_time:DateTime64(3)}}
          AND trace_start_time < {{end_time:DateTime64(3)}}
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
            sum(total_tokens) AS total_tokens,
            sum(cache_read_tokens) AS cache_read_tokens,
            sum(cache_write_tokens) AS cache_write_tokens
        FROM (
            SELECT
                trace_id, span_id, status, span_start_time, span_end_time, cost,
                input_tokens, output_tokens, total_tokens,
                {_CACHE_READ_TOKENS_EXPR} AS cache_read_tokens,
                {_CACHE_WRITE_TOKENS_EXPR} AS cache_write_tokens
            FROM spans
            WHERE project_id = {{project_id:String}}
              AND {customer_traffic_only()}
              AND span_start_time >= {{start_time:DateTime64(3)}}
              AND span_start_time < {{end_time:DateTime64(3)}}
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
        builder_aggs=BUILDER_AGGS_NUMBER,
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
            # Equality only: the domain is two values, so `contains` is a slower `=`.
            # Alerts-only: the one way to reach request-level latency at span grain.
            "is_root": FieldDef(
                expr=_IS_ROOT_EXPR,
                type="string",
                label="Root span",
                filter_ops=("=",),
                in_builder=False,
            ),
            # Labels follow the trace-list filter vocabulary (see
            # rest.services.filters.columns); units surface as input adornments
            # in the builder, not in the label.
            "duration_ms": _number_measure("duration_ms", "Duration"),
            "cost": _number_measure("cost", "Cost"),
            "input_tokens": _number_measure("input_tokens", "Input tokens"),
            "output_tokens": _number_measure("output_tokens", "Output tokens"),
            "cache_read_tokens": _number_measure("cache_read_tokens", "Cache read tokens"),
            "cache_write_tokens": _number_measure("cache_write_tokens", "Cache write tokens"),
            # Total last: input + output. Cache read/write are a breakdown of
            # the input above, not additional addends — summing all four
            # double-counts the cache tokens.
            "total_tokens": _number_measure("total_tokens", "Total tokens"),
            # Over the millisecond span duration, not a second-boundary count, so a
            # 200ms span reports its real rate. Zero duration reads NULL.
            "tokens_per_second": FieldDef(
                expr="tokens_per_second",
                type="number",
                label="Tokens per second",
                aggs=AGGS_NUMBER,
                in_builder=False,
            ),
            # Distinct-count measure for alerts. Not filterable or groupable: a
            # predicate or breakdown on one trace id is meaningless.
            "trace_id": FieldDef(
                expr="trace_id",
                type="string",
                label="Trace ID",
                aggs=("count", "uniq"),
                in_builder=False,
            ),
            # expr="*" is a sentinel: the compiler translates it to count(*).
            "count": FieldDef(expr="*", type="number", label="Count", aggs=("count",)),
            # Operators match the trace-list registry, so the same question spelled
            # in either UI lowers to the same comparison. Span scope only, unlike the
            # trace-list predicate, which ORs a trace-row arm onto the span scan: a
            # trace-scope key matches no span.
            "metadata": FieldDef(
                expr=METADATA_MAP_COLUMN,
                type="string",
                label="Metadata",
                filter_ops=FILTER_OPS_STRING,
                requires_key=True,
                in_builder=False,
            ),
        },
    ),
    "traces": ViewDef(
        base_sql=_TRACES_BASE,
        fields={
            "name": _string_dim("name", "Trace name"),
            # Dimensions to the builder as before; distinct-count measures to alerts.
            # `builder_aggs=()` keeps that second role out of the builder's measures.
            "user_id": FieldDef(
                expr="user_id",
                type="string",
                label="User",
                filter_ops=FILTER_OPS_STRING,
                groupable=True,
                aggs=("count", "uniq"),
                builder_aggs=(),
            ),
            "session_id": FieldDef(
                expr="session_id",
                type="string",
                label="Session",
                filter_ops=FILTER_OPS_STRING,
                groupable=True,
                aggs=("count", "uniq"),
                builder_aggs=(),
            ),
            "environment": _string_dim("environment", "Environment"),
            # Same quantities the trace list exposes — same words (Latency,
            # Cost, Tokens, Errors), so filtering a widget reads like
            # filtering the trace list.
            "duration_ms": _number_measure("duration_ms", "Latency"),
            "cost": _number_measure("cost", "Cost"),
            "input_tokens": _number_measure("input_tokens", "Input tokens"),
            "output_tokens": _number_measure("output_tokens", "Output tokens"),
            "cache_read_tokens": _number_measure("cache_read_tokens", "Cache read tokens"),
            "cache_write_tokens": _number_measure("cache_write_tokens", "Cache write tokens"),
            # Total last: input + output. Cache read/write are a breakdown of
            # the input above, not additional addends — summing all four
            # double-counts the cache tokens.
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
    """JSON-friendly registry for `GET /widgets/schema`. Omits SQL exprs.

    `aggs` and `inBuilder` state what the builder offers, not what the engine can
    resolve; the alert form takes its measure vocabulary from `@traceroot/core`.
    """
    return {
        view_name: {
            "fields": {
                fname: {
                    "type": f.type,
                    "label": f.label,
                    "filterOps": list(f.filter_ops),
                    "groupable": f.groupable,
                    "aggs": list(f.aggs if f.builder_aggs is None else f.builder_aggs),
                    "inBuilder": f.in_builder,
                    "requiresKey": f.requires_key,
                    # Mirrors the compiler's histogram rule (numeric column,
                    # not the count(*) sentinel) so the builder can gate the
                    # histogram display instead of saving a widget that the
                    # query engine permanently rejects.
                    "histogrammable": f.type == "number" and f.expr != "*",
                }
                for fname, f in view.fields.items()
            }
        }
        for view_name, view in REGISTRY.items()
    }
