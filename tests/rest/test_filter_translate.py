"""Translator unit tests: predicates -> parameterized WHERE conditions.

The translator's contract is the load-bearing correctness piece: every condition it
returns is appended to the shared ``conditions`` list in ``list_traces`` (the one that
feeds BOTH the page CTE and the separate count query), so a membership/aggregate filter
keyed on ``t.trace_id`` filters the page and the total identically.
"""

import pytest

from rest.services.filters.translate import (
    SPAN_TIME_BOUND_LOOKBACK_HOURS,
    Predicate,
    build_conditions,
    parse_filters_param,
)


def test_parse_none_or_empty_yields_no_predicates():
    assert parse_filters_param(None) == []
    assert parse_filters_param("") == []


def test_parse_valid_json_array_yields_predicates():
    preds = parse_filters_param('[{"field":"model_name","op":"in","value":["gpt-4"]}]')
    assert preds == [Predicate(field="model_name", op="in", value=["gpt-4"])]


def test_parse_rejects_non_json():
    with pytest.raises(ValueError):
        parse_filters_param("not json")


def test_parse_rejects_non_array():
    with pytest.raises(ValueError):
        parse_filters_param('{"field":"model_name","op":"in","value":["x"]}')


def test_validation_rejects_malformed_in_value():
    # 'in' needs a list of strings, not a bare value or non-strings.
    with pytest.raises(ValueError):
        build_conditions([Predicate(field="model_name", op="in", value="gpt-4")], {})
    with pytest.raises(ValueError):
        build_conditions([Predicate(field="model_name", op="in", value=[1, 2])], {})


def test_validation_rejects_empty_in_list():
    # An empty IN list matches nothing — reject it rather than emit `col IN []`.
    with pytest.raises(ValueError):
        build_conditions([Predicate(field="model_name", op="in", value=[])], {})


def test_validation_rejects_malformed_between_value():
    # 'between' needs a two-element [min, max] list of numbers (either may be null).
    for bad in (5, [5], [1, 2, 3], ["a", "b"], [True, None]):
        with pytest.raises(ValueError):
            build_conditions([Predicate(field="cost", op="between", value=bad)], {})


def test_validation_rejects_fractional_bound_on_integer_field():
    # total_tokens/errors/duration_ms are integer-typed; a fractional bound is a
    # BAD_QUERY_PARAMETER at ClickHouse, so reject it at the edge (422, not a 500).
    for field in ("total_tokens", "errors", "duration_ms"):
        with pytest.raises(ValueError):
            build_conditions([Predicate(field=field, op="between", value=[1.5, None])], {})
        with pytest.raises(ValueError):
            build_conditions([Predicate(field=field, op="between", value=[None, 2.5])], {})


def test_validation_rejects_negative_bound():
    # The metrics are all non-negative; a negative bound can't bind to UInt64 (errors)
    # and would 500 in ClickHouse, so reject it at the edge (422) for every numeric field.
    for field in ("errors", "total_tokens", "duration_ms", "cost"):
        with pytest.raises(ValueError):
            build_conditions([Predicate(field=field, op="between", value=[-5, None])], {})


def test_validation_rejects_non_finite_bound():
    # json.loads accepts NaN/Infinity by default; a non-finite bound would 500 at bind.
    for bad in (float("inf"), float("-inf"), float("nan")):
        with pytest.raises(ValueError):
            build_conditions([Predicate(field="cost", op="between", value=[bad, None])], {})


def test_validation_rejects_out_of_range_integer_bound():
    # A value beyond the column's integer type can't bind — total_tokens is Int64. Include
    # an arbitrary-size int that would OverflowError in float() coercion (must be a clean
    # ValueError/422, not a 500).
    for huge in (2**63, 10**400):
        with pytest.raises(ValueError):
            build_conditions(
                [Predicate(field="total_tokens", op="between", value=[huge, None])], {}
            )


def test_validation_rejects_oversized_decimal_bound():
    # cost is Decimal64(9); a value beyond its range would overflow at binding (500), so
    # reject it at the edge too — the range check isn't integer-only.
    for huge in (10**9, 10**30):
        with pytest.raises(ValueError):
            build_conditions([Predicate(field="cost", op="between", value=[huge, None])], {})


def test_fractional_bound_allowed_on_decimal_cost():
    # cost is Decimal-typed — fractional bounds are valid and must not be rejected.
    conds = build_conditions(
        [Predicate(field="cost", op="between", value=[0.5, None])], {"project_id": "p1"}
    )
    assert conds  # a condition was produced, no ValueError


def test_integer_valued_float_bound_is_coerced_to_int():
    # A whole-number float (e.g. 5.0 from a hand-crafted URL) is accepted and bound as an
    # int, so it isn't sent to ClickHouse as "5.0" (unparseable as Int64).
    params = {"project_id": "p1"}
    build_conditions([Predicate(field="total_tokens", op="between", value=[5.0, 10.0])], params)
    bounds = [v for k, v in params.items() if k.endswith(("_min", "_max"))]
    assert set(bounds) == {5, 10}
    assert all(isinstance(v, int) for v in bounds)


def test_duplicate_predicates_on_same_field_get_distinct_params():
    # Two predicates on one field must not clobber each other's bound params.
    params = {"project_id": "p1"}
    build_conditions(
        [
            Predicate(field="cost", op="between", value=[1, None]),
            Predicate(field="cost", op="between", value=[None, 9]),
        ],
        params,
    )
    assert 1 in params.values() and 9 in params.values()


def test_parse_rejects_non_object_array_element():
    with pytest.raises(ValueError):
        parse_filters_param("[123]")


def test_parse_rejects_predicate_missing_required_keys():
    with pytest.raises(ValueError):
        parse_filters_param('[{"op":"in","value":["x"]}]')  # no field


def test_parse_rejects_unknown_field():
    with pytest.raises(ValueError):
        parse_filters_param('[{"field":"nope","op":"in","value":["x"]}]')


def test_parse_rejects_bad_operator_for_field():
    with pytest.raises(ValueError):
        parse_filters_param('[{"field":"cost","op":"in","value":[1]}]')


def test_membership_predicate_lowers_to_a_project_scoped_span_semijoin():
    params = {"project_id": "p1"}
    conditions = build_conditions(
        [Predicate(field="model_name", op="in", value=["claude-opus-4.8", "gpt-4"])],
        params,
    )
    assert len(conditions) == 1
    cond = conditions[0]
    # Keyed on t.trace_id (so it filters page AND count), scoped to the same project.
    assert "t.trace_id IN (" in cond
    assert "FROM spans" in cond
    assert "project_id = {project_id:String}" in cond
    assert "model_name IN" in cond
    # Deduped to the latest ReplacingMergeTree version per span before the IN match, so a
    # stale row can't match a value the latest span version no longer has.
    assert "LIMIT 1 BY project_id, trace_id, span_id" in cond
    # The value is bound as a parameter, never interpolated into the SQL text.
    assert ["claude-opus-4.8", "gpt-4"] in params.values()
    assert "claude-opus-4.8" not in cond


def test_membership_predicates_on_different_fields_emit_independent_semijoins():
    # Independent existence: each membership predicate is its OWN semi-join, AND-combined,
    # so a trace matches if it has >=1 span for EACH predicate independently (NOT one span
    # satisfying both). Two fields -> two separate t.trace_id IN (...) conditions.
    params = {"project_id": "p1"}
    conditions = build_conditions(
        [
            Predicate(field="model_name", op="in", value=["gpt-4"]),
            Predicate(field="environment", op="in", value=["prod"]),
        ],
        params,
    )
    assert len(conditions) == 2
    assert all(c.startswith("t.trace_id IN (") for c in conditions)
    # Each semi-join carries only its own field's condition, not the other's (not merged).
    model_cond = next(c for c in conditions if "model_name IN" in c)
    env_cond = next(c for c in conditions if "environment IN" in c)
    assert "environment IN" not in model_cond
    assert "model_name IN" not in env_cond
    # Per-predicate param indexing keeps the two from colliding.
    assert params["f_model_name_0"] == ["gpt-4"]
    assert params["f_environment_1"] == ["prod"]


def test_aggregate_inner_projection_is_registry_driven():
    # The aggregate inner SELECT projects the structural columns plus only the active
    # field's source_columns — a cost filter projects cost, NOT total_tokens or status.
    params = {"project_id": "p1"}
    cond = build_conditions([Predicate(field="cost", op="between", value=[0.5, None])], params)[0]
    # The inner projection is the SELECT list feeding "FROM spans" (not the outer wrapper).
    inner_select_start = cond.index("SELECT", cond.index("SELECT") + 1)
    select = cond[inner_select_start : cond.index("FROM spans")]
    assert "cost" in select
    assert "total_tokens" not in select
    assert "status" not in select
    # A cost filter doesn't need span_start_time projected — it's only filtered in the
    # inner WHERE, not selected — so it isn't over-projected here.
    assert "span_start_time" not in select
    # The dedup/group keys are always present.
    for structural in ("trace_id", "span_id", "project_id"):
        assert structural in select
    # A duration filter DOES project span_start_time + span_end_time — supplied by its
    # source_columns, not hardcoded — confirming the projection is registry-driven.
    dcond = build_conditions(
        [Predicate(field="duration_ms", op="between", value=[5, None])], {"project_id": "p1"}
    )[0]
    dsel = dcond[dcond.index("SELECT", dcond.index("SELECT") + 1) : dcond.index("FROM spans")]
    assert "span_start_time" in dsel and "span_end_time" in dsel


def test_unknown_field_is_rejected():
    with pytest.raises(ValueError):
        build_conditions([Predicate(field="not_a_field", op="in", value=["x"])], {})


def test_operator_not_in_field_whitelist_is_rejected():
    # cost only allows BETWEEN, not IN.
    with pytest.raises(ValueError):
        build_conditions([Predicate(field="cost", op="in", value=[1])], {})


def test_aggregate_between_lowers_to_a_having_semijoin_with_both_bounds():
    params = {"project_id": "p1"}
    conditions = build_conditions([Predicate(field="cost", op="between", value=[0.5, 10])], params)
    assert len(conditions) == 1
    cond = conditions[0]
    assert "t.trace_id IN (" in cond
    assert "GROUP BY trace_id" in cond
    assert "HAVING" in cond
    assert "sum(cost) BETWEEN" in cond
    assert "project_id = {project_id:String}" in cond
    # both bounds bound as params, not interpolated
    assert 0.5 in params.values() and 10 in params.values()
    assert "0.5" not in cond


def test_aggregate_open_lower_bound_lowers_to_inclusive_gte():
    params = {"project_id": "p1"}
    cond = build_conditions([Predicate(field="cost", op="between", value=[0.5, None])], params)[0]
    assert "sum(cost) >=" in cond  # "greater than or equal to" is an inclusive >= bound
    assert "BETWEEN" not in cond and "<" not in cond


def test_aggregate_open_upper_bound_lowers_to_inclusive_lte():
    params = {"project_id": "p1"}
    cond = build_conditions([Predicate(field="cost", op="between", value=[None, 10])], params)[0]
    assert "sum(cost) <=" in cond  # "less than or equal to" is an inclusive <= bound
    assert "BETWEEN" not in cond and ">=" not in cond


def test_errors_aggregate_counts_error_spans_per_trace():
    params = {"project_id": "p1"}
    cond = build_conditions([Predicate(field="errors", op="between", value=[3, None])], params)[0]
    assert "countIf(status = 'ERROR') >=" in cond
    assert "GROUP BY trace_id HAVING" in cond
    assert "status" in cond  # inner SELECT carries status for the count


def test_duration_aggregate_uses_min_max_expr_not_sum():
    params = {"project_id": "p1"}
    cond = build_conditions(
        [Predicate(field="duration_ms", op="between", value=[100, 5000])], params
    )[0]
    assert "min(span_start_time)" in cond and "max(span_end_time)" in cond
    assert "sum(" not in cond


def test_aggregate_with_no_bounds_is_a_noop_and_emits_nothing():
    # An empty range (both bounds absent) contributes no SQL — not an error.
    params = {"project_id": "p1"}
    assert (
        build_conditions([Predicate(field="cost", op="between", value=[None, None])], params) == []
    )


def test_start_after_in_params_bounds_both_semijoins():
    params = {"project_id": "p1", "start_after": "2026-06-01 00:00:00"}
    conditions = build_conditions(
        [
            Predicate(field="model_name", op="in", value=["gpt-4"]),
            Predicate(field="cost", op="between", value=[1, None]),
        ],
        params,
    )
    assert len(conditions) == 2  # one membership semi-join, one aggregate semi-join
    for cond in conditions:
        assert "span_start_time >= {start_after:DateTime64(3)}" in cond


def test_span_time_bound_backs_off_for_boundary_drift():
    """The span-scan lower bound subtracts a small lookback from start_after, so a span
    that started just before the window boundary (clock skew vs. trace_start_time) is not
    dropped — which would false-negative an otherwise-matching in-window trace."""
    params = {"project_id": "p1", "start_after": "2026-06-01 00:00:00"}
    conditions = build_conditions([Predicate(field="model_name", op="in", value=["gpt-4"])], params)
    assert (
        f"span_start_time >= {{start_after:DateTime64(3)}} - INTERVAL "
        f"{SPAN_TIME_BOUND_LOOKBACK_HOURS} HOUR" in conditions[0]
    )
