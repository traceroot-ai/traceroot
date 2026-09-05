"""SQL helpers for trace/session/user token rollups.

Span-level token columns can mix API-provided counts with text-estimated fallback
counts. When a trace has any API-counted spans, trace-level totals should prefer
those authoritative spans and ignore wrapper estimates that restate child usage.
"""


def api_token_span_predicate(usage_details_col: str = "usage_details") -> str:
    """Return the ClickHouse predicate that marks API-provided token spans.

    The ingest path writes ``usage_details`` only for instrumentor/API token-count
    branches. Text-estimated spans leave the map empty.
    """

    return f"length(mapKeys({usage_details_col})) > 0"


def authoritative_sum_expr(column: str, usage_details_col: str = "usage_details") -> str:
    """Prefer API-counted spans for a group, falling back to all spans.

    The expression is intended for grouped ClickHouse queries. Within each group,
    if at least one span has API token-count metadata, sum only those spans;
    otherwise preserve the old behavior and sum all spans.
    """

    predicate = api_token_span_predicate(usage_details_col)
    return f"if(countIf({predicate}) > 0, sumIf({column}, {predicate}), sum({column}))"


def authoritative_token_rollup_select(
    *,
    input_alias: str = "total_input_tokens",
    output_alias: str = "total_output_tokens",
    cost_alias: str = "total_cost",
    source_prefix: str = "",
) -> str:
    """Return a SELECT fragment for input/output/cost rollups."""

    usage_details_col = f"{source_prefix}usage_details"
    return "\n".join(
        [
            f"{authoritative_sum_expr(f'{source_prefix}input_tokens', usage_details_col)} as {input_alias},",
            f"{authoritative_sum_expr(f'{source_prefix}output_tokens', usage_details_col)} as {output_alias},",
            f"{authoritative_sum_expr(f'{source_prefix}cost', usage_details_col)} as {cost_alias}",
        ]
    )
