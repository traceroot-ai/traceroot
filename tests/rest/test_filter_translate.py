"""Translator unit tests: predicates -> parameterized WHERE conditions.

The translator's contract is the load-bearing correctness piece: every condition it
returns is appended to the shared ``conditions`` list in ``list_traces`` (the one that
feeds BOTH the page CTE and the separate count query), so a membership / aggregate /
trace-level filter keyed on ``t.trace_id`` filters the page and the total identically.

Operators are explicit and scalar: categorical ``in`` (array),
numeric ``eq/gt/gte/lt/lte`` (a single number), and text ``eq/contains`` (a string).
"""

import pytest

from rest.services.filters.translate import (
    SPAN_TIME_BOUND_LOOKBACK_HOURS,
    Predicate,
    build_conditions,
    parse_filters_param,
)
from rest.services.token_rollup import authoritative_sum_expr

# --- parsing ---------------------------------------------------------------


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
    # cost is numeric — the `in` operator isn't in its whitelist.
    with pytest.raises(ValueError):
        parse_filters_param('[{"field":"cost","op":"in","value":[1]}]')


# --- categorical `in` validation -------------------------------------------


def test_validation_rejects_malformed_in_value():
    with pytest.raises(ValueError):
        build_conditions([Predicate(field="model_name", op="in", value="gpt-4")], {})
    with pytest.raises(ValueError):
        build_conditions([Predicate(field="model_name", op="in", value=[1, 2])], {})


def test_validation_rejects_empty_in_list():
    with pytest.raises(ValueError):
        build_conditions([Predicate(field="model_name", op="in", value=[])], {})


# --- numeric comparison validation -----------------------------------------


def test_numeric_op_requires_a_single_number():
    # A numeric comparison takes one number — not a list, string, null, or bool.
    for bad in ([1, 2], "5", None, True):
        with pytest.raises(ValueError):
            build_conditions([Predicate(field="cost", op="gt", value=bad)], {})


def test_numeric_rejects_negative():
    # The metrics are all non-negative; a negative can't bind to a UInt64 and would 500.
    for field in ("cost", "total_tokens", "duration_ms", "errors"):
        with pytest.raises(ValueError):
            build_conditions([Predicate(field=field, op="gte", value=-5)], {})


def test_numeric_rejects_non_finite():
    for bad in (float("inf"), float("-inf"), float("nan")):
        with pytest.raises(ValueError):
            build_conditions([Predicate(field="cost", op="lt", value=bad)], {})


def test_numeric_rejects_fractional_on_integer_field():
    for field in ("total_tokens", "errors", "duration_ms"):
        with pytest.raises(ValueError):
            build_conditions([Predicate(field=field, op="gt", value=1.5)], {})


def test_numeric_rejects_out_of_range():
    # Beyond the column type's range can't bind (would OverflowError / 500).
    for huge in (2**63, 10**400):
        with pytest.raises(ValueError):
            build_conditions([Predicate(field="total_tokens", op="lt", value=huge)], {})
    for huge in (10**9, 10**30):
        with pytest.raises(ValueError):
            build_conditions([Predicate(field="cost", op="lt", value=huge)], {})


def test_fractional_value_allowed_on_decimal_cost():
    conds = build_conditions([Predicate(field="cost", op="gte", value=0.5)], {"project_id": "p1"})
    assert conds  # a condition was produced, no ValueError


def test_integer_valued_float_is_coerced_to_int():
    # 5.0 from a hand-crafted URL is bound as int 5, not "5.0" (unparseable as Int64).
    params = {"project_id": "p1"}
    build_conditions([Predicate(field="total_tokens", op="gte", value=5.0)], params)
    bound = [v for k, v in params.items() if k.startswith("f_total_tokens")]
    assert bound == [5]
    assert isinstance(bound[0], int)


# --- text (trace_id) validation --------------------------------------------


def test_text_op_requires_a_non_empty_string():
    for bad in ("", 5, None, ["abc"]):
        with pytest.raises(ValueError):
            build_conditions([Predicate(field="trace_id", op="eq", value=bad)], {})
        with pytest.raises(ValueError):
            build_conditions([Predicate(field="trace_id", op="contains", value=bad)], {})


# --- whitelist boundary ----------------------------------------------------


def test_unknown_field_is_rejected():
    with pytest.raises(ValueError):
        build_conditions([Predicate(field="not_a_field", op="eq", value=1)], {})


def test_operator_not_in_field_whitelist_is_rejected():
    # cost (numeric) doesn't allow `contains`; trace_id (text) doesn't allow `gt`.
    with pytest.raises(ValueError):
        build_conditions([Predicate(field="cost", op="contains", value="x")], {})
    with pytest.raises(ValueError):
        build_conditions([Predicate(field="trace_id", op="gt", value=1)], {})


# --- categorical membership lowering ---------------------------------------


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
    assert "LIMIT 1 BY project_id, trace_id, span_id" in cond
    # The value is bound as a parameter, never interpolated into the SQL text.
    assert ["claude-opus-4.8", "gpt-4"] in params.values()
    assert "claude-opus-4.8" not in cond


def test_membership_predicates_on_different_fields_emit_independent_semijoins():
    # Independent existence: each membership predicate is its OWN semi-join, AND-combined.
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
    model_cond = next(c for c in conditions if "model_name IN" in c)
    env_cond = next(c for c in conditions if "environment IN" in c)
    assert "environment IN" not in model_cond
    assert "model_name IN" not in env_cond
    assert params["f_model_name_0"] == ["gpt-4"]
    assert params["f_environment_1"] == ["prod"]


# --- numeric aggregate lowering (explicit operators) -----------------------


@pytest.mark.parametrize(
    "op,token",
    [
        ("eq", f"{authoritative_sum_expr('cost')} = {{"),
        ("gt", f"{authoritative_sum_expr('cost')} > {{"),
        ("gte", f"{authoritative_sum_expr('cost')} >= {{"),
        ("lt", f"{authoritative_sum_expr('cost')} < {{"),
        ("lte", f"{authoritative_sum_expr('cost')} <= {{"),
    ],
)
def test_numeric_operator_lowers_to_its_having_comparison(op, token):
    # The trailing `{` disambiguates `>`/`>=` and `<`/`<=` (the param placeholder follows).
    params = {"project_id": "p1"}
    cond = build_conditions([Predicate(field="cost", op=op, value=0.5)], params)[0]
    assert "t.trace_id IN (" in cond
    assert "GROUP BY trace_id HAVING" in cond
    assert token in cond
    # The value is bound as a param, not interpolated.
    assert 0.5 in params.values()
    assert "0.5" not in cond


def test_errors_aggregate_counts_error_spans_per_trace():
    params = {"project_id": "p1"}
    cond = build_conditions([Predicate(field="errors", op="gte", value=3)], params)[0]
    assert "countIf(status = 'ERROR') >= {" in cond
    assert "GROUP BY trace_id HAVING" in cond
    assert 3 in params.values()


def test_duration_aggregate_uses_min_max_expr_not_sum():
    params = {"project_id": "p1"}
    cond = build_conditions([Predicate(field="duration_ms", op="gt", value=100)], params)[0]
    assert "min(span_start_time)" in cond and "max(span_end_time)" in cond
    assert "sum(" not in cond


def test_multiple_numeric_predicates_on_same_field_form_a_range():
    # A range is two one-sided predicates AND-combined in ONE HAVING (page and count alike).
    params = {"project_id": "p1"}
    conditions = build_conditions(
        [
            Predicate(field="cost", op="gt", value=1),
            Predicate(field="cost", op="lte", value=10),
        ],
        params,
    )
    assert len(conditions) == 1
    cond = conditions[0]
    cost_expr = authoritative_sum_expr("cost")
    assert f"{cost_expr} > {{" in cond
    assert f"{cost_expr} <= {{" in cond
    assert " AND " in cond
    assert 1 in params.values() and 10 in params.values()


def test_cost_filter_projects_usage_details_for_authoritative_token_rollup():
    params = {"project_id": "p1"}
    cond = build_conditions([Predicate(field="cost", op="gt", value=1)], params)[0]

    select_clause = cond.split("FROM spans", 1)[0]
    assert "usage_details" in select_clause
    assert authoritative_sum_expr("cost") in cond


def test_duplicate_predicates_on_same_field_get_distinct_params():
    params = {"project_id": "p1"}
    build_conditions(
        [
            Predicate(field="cost", op="gt", value=1),
            Predicate(field="cost", op="lt", value=9),
        ],
        params,
    )
    assert 1 in params.values() and 9 in params.values()


def test_aggregate_inner_projection_is_registry_driven():
    # The inner SELECT projects the structural keys plus only the active field's
    # source_columns — a cost filter projects cost, NOT total_tokens or status.
    params = {"project_id": "p1"}
    cond = build_conditions([Predicate(field="cost", op="gt", value=0.5)], params)[0]
    inner_select_start = cond.index("SELECT", cond.index("SELECT") + 1)
    select = cond[inner_select_start : cond.index("FROM spans")]
    assert "cost" in select
    assert "total_tokens" not in select
    assert "status" not in select
    assert "span_start_time" not in select
    for structural in ("trace_id", "span_id", "project_id"):
        assert structural in select
    # A duration filter DOES project span_start_time + span_end_time — from its
    # source_columns, confirming the projection is registry-driven, not hardcoded.
    dcond = build_conditions(
        [Predicate(field="duration_ms", op="gt", value=5)], {"project_id": "p1"}
    )[0]
    dsel = dcond[dcond.index("SELECT", dcond.index("SELECT") + 1) : dcond.index("FROM spans")]
    assert "span_start_time" in dsel and "span_end_time" in dsel


# --- text (trace_id) lowering ----------------------------------------------


def test_trace_id_eq_lowers_to_an_inline_equality():
    # TRACE-level fields filter the traces row directly (t.*), keyed on t.trace_id so
    # they land in both the page and count queries. No span subquery.
    params = {"project_id": "p1"}
    cond = build_conditions([Predicate(field="trace_id", op="eq", value="abc123")], params)[0]
    assert cond == "t.trace_id = {f_trace_id_0:String}"
    assert params["f_trace_id_0"] == "abc123"
    assert "abc123" not in cond  # bound, not interpolated


def test_trace_id_contains_lowers_to_a_parameterized_ilike():
    params = {"project_id": "p1"}
    cond = build_conditions([Predicate(field="trace_id", op="contains", value="abc")], params)[0]
    assert cond == "t.trace_id ILIKE {f_trace_id_0:String}"
    assert params["f_trace_id_0"] == "%abc%"  # case-insensitive substring


def test_trace_id_contains_escapes_ilike_wildcards():
    # A literal % or _ in the search must be escaped so it matches literally, not as a
    # wildcard — otherwise "100%" would match every id containing "100".
    params = {"project_id": "p1"}
    build_conditions([Predicate(field="trace_id", op="contains", value="a%b_c")], params)
    assert params["f_trace_id_0"] == "%a\\%b\\_c%"


def test_trace_id_condition_is_inline_not_a_semijoin():
    params = {"project_id": "p1"}
    cond = build_conditions([Predicate(field="trace_id", op="eq", value="x")], params)[0]
    assert "SELECT" not in cond
    assert "spans" not in cond


# --- time-window bounding --------------------------------------------------


def test_start_after_in_params_bounds_span_semijoins():
    params = {"project_id": "p1", "start_after": "2026-06-01 00:00:00"}
    conditions = build_conditions(
        [
            Predicate(field="model_name", op="in", value=["gpt-4"]),
            Predicate(field="cost", op="gt", value=1),
        ],
        params,
    )
    assert len(conditions) == 2  # one membership semi-join, one aggregate semi-join
    for cond in conditions:
        assert "span_start_time >=" in cond


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


def test_trace_id_condition_has_no_span_time_bound():
    # An inline trace-row predicate doesn't scan spans, so start_after doesn't apply.
    params = {"project_id": "p1", "start_after": "2026-06-01 00:00:00"}
    cond = build_conditions([Predicate(field="trace_id", op="contains", value="x")], params)[0]
    assert "span_start_time" not in cond
