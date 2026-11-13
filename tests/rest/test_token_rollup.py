from rest.services.token_rollup import (
    api_token_span_predicate,
    authoritative_sum_expr,
    authoritative_token_rollup_select,
)


def test_api_token_span_predicate_uses_usage_details_map():
    assert api_token_span_predicate() == "length(mapKeys(usage_details)) > 0"
    assert api_token_span_predicate("s.usage_details") == "length(mapKeys(s.usage_details)) > 0"


def test_authoritative_sum_prefers_api_counted_spans_then_falls_back():
    expr = authoritative_sum_expr("input_tokens")

    assert "countIf(length(mapKeys(usage_details)) > 0) > 0" in expr
    assert "sumIf(input_tokens, length(mapKeys(usage_details)) > 0)" in expr
    assert "sum(input_tokens)" in expr


def test_authoritative_rollup_select_can_prefix_joined_span_columns():
    select = authoritative_token_rollup_select(source_prefix="s.")

    assert "sumIf(s.input_tokens, length(mapKeys(s.usage_details)) > 0)" in select
    assert "as total_input_tokens" in select
    assert "sumIf(s.output_tokens, length(mapKeys(s.usage_details)) > 0)" in select
    assert "as total_output_tokens" in select
    assert "sumIf(s.cost, length(mapKeys(s.usage_details)) > 0)" in select
    assert "as total_cost" in select
