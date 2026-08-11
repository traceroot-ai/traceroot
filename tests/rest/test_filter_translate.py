"""Translator unit tests: predicates -> parameterized WHERE conditions.

Every condition the translator returns is appended to the shared ``conditions`` list in
``list_traces``, which feeds BOTH the page CTE and the separate count query, so a condition
keyed on ``t.trace_id`` filters the page and the total identically.

Operators are explicit and scalar: categorical ``in`` (array), numeric ``eq/gt/gte/lt/lte``
(one number), text ``eq/contains`` (a string). A keyed field (``metadata``) adds a ``key``
slot bound as a parameter rather than resolved as an identifier, and matches the pair at
either scope — the traces row or any of the trace's spans — so its two halves are asserted
separately throughout, its span half through the one shared span-scan builder.
"""

import json

import pytest

from rest.services.filters import translate
from rest.services.filters.columns import (
    FILTER_COLUMNS,
    FilterColumn,
    FilterOperator,
    FilterType,
    ValueSource,
)
from rest.services.filters.translate import (
    MAX_FILTERS,
    MAX_KEY_LENGTH,
    MAX_VALUE_LENGTH,
    SPAN_TIME_BOUND_LOOKBACK_HOURS,
    Predicate,
    build_conditions,
    parse_filters_param,
)

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


def _filters_json(count: int, field: str = "model_name") -> str:
    """A filters param carrying ``count`` well-formed predicates on one field."""
    return json.dumps([{"field": field, "op": "in", "value": ["gpt-4"]} for _ in range(count)])


def test_parse_accepts_the_maximum_number_of_predicates_and_rejects_one_more():
    # Every span-level predicate lowers to its own scan in BOTH the page and the count
    # query, so the array length is the one input whose cost `limit` doesn't bound.
    assert len(parse_filters_param(_filters_json(MAX_FILTERS))) == MAX_FILTERS
    with pytest.raises(ValueError):
        parse_filters_param(_filters_json(MAX_FILTERS + 1))


def test_parse_rejects_an_oversized_array_without_validating_its_items():
    """The bound sits before the per-item loop, so an oversized array costs one length
    check rather than a parse and a registry lookup per element. Asserted through the
    error it raises rather than by reaching into the parser: every item here would also
    fail validation (unknown field, no op, no value), so the length message can only be
    the one raised if the check ran first."""
    raw = json.dumps([{"field": "nope"} for _ in range(MAX_FILTERS + 1)])
    with pytest.raises(ValueError, match="more than the maximum"):
        parse_filters_param(raw)


# --- categorical `in` validation -------------------------------------------


def test_validation_rejects_malformed_in_value():
    with pytest.raises(ValueError):
        build_conditions([Predicate(field="model_name", op="in", value="gpt-4")], {})
    with pytest.raises(ValueError):
        build_conditions([Predicate(field="model_name", op="in", value=[1, 2])], {})


def test_validation_rejects_empty_in_list():
    with pytest.raises(ValueError):
        build_conditions([Predicate(field="model_name", op="in", value=[])], {})


def test_in_list_element_at_the_length_cap_is_accepted_and_beyond_it_is_rejected():
    """The cap is per element, not on the list: each one binds into the same Array
    parameter on both the page and the count query. The list is deliberately short in both
    cases, so neither outcome can come from a bound on how many values an `in` may carry."""

    def one_long_element(length: int) -> Predicate:
        return Predicate(field="model_name", op="in", value=["gpt-4", "m" * length])

    assert build_conditions([one_long_element(MAX_VALUE_LENGTH)], {"project_id": "p1"})
    with pytest.raises(ValueError):
        build_conditions([one_long_element(MAX_VALUE_LENGTH + 1)], {"project_id": "p1"})


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


def test_text_value_at_the_length_cap_is_accepted_and_beyond_it_is_rejected():
    """A value is free text the caller types and binds on the page and the count query
    alike, so it is bounded at the edge like the key. It gets more room than a key —
    a value is compared, not looked up — and a `contains` one becomes an ILIKE pattern
    matched against every row the scan surfaces, which is why it is bounded at all."""
    for op in ("eq", "contains"):
        at_cap = Predicate(field="trace_id", op=op, value="x" * MAX_VALUE_LENGTH)
        assert build_conditions([at_cap], {"project_id": "p1"})
        over_cap = Predicate(field="trace_id", op=op, value="x" * (MAX_VALUE_LENGTH + 1))
        with pytest.raises(ValueError):
            build_conditions([over_cap], {"project_id": "p1"})


# --- keyed field (metadata) key validation ---------------------------------


def _metadata(op="eq", value="acme-corp", key="tenant_id") -> Predicate:
    """A well-formed metadata predicate; per-test overrides isolate one bad slot."""
    return Predicate(field="metadata", op=op, value=value, key=key)


@pytest.mark.parametrize(
    "key_json", ["", ',"key":""', ',"key":5', ',"key":{"a":1}', ',"key":["tenant_id"]']
)
def test_a_metadata_predicate_needs_a_non_empty_string_key(key_json):
    # There is no default map key to fall back on, and a JSON number/object/array is not a
    # key: reject at the edge (422) rather than answer a different question than the one asked.
    with pytest.raises(ValueError):
        parse_filters_param(f'[{{"field":"metadata","op":"eq","value":"acme-corp"{key_json}}}]')


def test_metadata_key_at_the_length_cap_is_accepted_and_beyond_it_is_rejected():
    # The key is free text the registry never vouches for and it binds on both the page
    # and the count query, so it is bounded at the edge instead of shipped to ClickHouse.
    at_cap = "k" * MAX_KEY_LENGTH
    assert build_conditions([_metadata(key=at_cap)], {"project_id": "p1"})
    with pytest.raises(ValueError):
        build_conditions([_metadata(key="k" * (MAX_KEY_LENGTH + 1))], {"project_id": "p1"})


def test_key_on_a_field_that_takes_none_is_rejected():
    # A key on an unkeyed field means the caller has the field's shape wrong; silently
    # dropping it would answer a different question than the one asked.
    for pred in (
        Predicate(field="model_name", op="in", value=["gpt-4"], key="tenant_id"),
        Predicate(field="trace_id", op="eq", value="abc", key="tenant_id"),
        Predicate(field="cost", op="gt", value=1, key="tenant_id"),
    ):
        with pytest.raises(ValueError):
            build_conditions([pred], {"project_id": "p1"})


def test_metadata_operator_whitelist_is_eq_and_contains_only():
    # No per-key type inference in v1 — no numeric comparisons, no categorical `in`.
    for op in ("in", "gt", "gte", "lt", "lte"):
        with pytest.raises(ValueError):
            build_conditions([_metadata(op=op, value="acme-corp")], {"project_id": "p1"})


def test_metadata_value_must_be_a_non_empty_string():
    # An empty value is rejected at the edge for both operators: with ClickHouse's map
    # subscript defaulting, a bare `= ''` would otherwise be a match-everything filter.
    for bad in ("", 5, None, ["acme-corp"], True):
        for op in ("eq", "contains"):
            with pytest.raises(ValueError):
                build_conditions([_metadata(op=op, value=bad)], {"project_id": "p1"})


def test_metadata_value_is_bounded_like_any_other_text_value():
    # The keyed field bounds its key and its value independently: a key at its own cap
    # alongside a value one character past the value cap is still rejected.
    assert build_conditions([_metadata(value="v" * MAX_VALUE_LENGTH)], {"project_id": "p1"})
    with pytest.raises(ValueError):
        build_conditions(
            [_metadata(key="k" * MAX_KEY_LENGTH, value="v" * (MAX_VALUE_LENGTH + 1))],
            {"project_id": "p1"},
        )


def test_parse_round_trips_a_metadata_key_from_the_filters_param():
    preds = parse_filters_param(
        '[{"field":"metadata","op":"eq","value":"acme-corp","key":"tenant_id"}]'
    )
    assert preds == [Predicate(field="metadata", op="eq", value="acme-corp", key="tenant_id")]


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


# --- keyed map (metadata) lowering -----------------------------------------
# Trace-scope and span-scope keys are disjoint, so one keyed predicate matches at EITHER
# scope. Both halves are asserted separately, because a half that quietly stops matching is
# invisible in a test that only looks at the whole condition.


def _or_parts_at_top_level(expr: str) -> list[str]:
    """Split a SQL expression on ``OR`` at parenthesis depth zero.

    Conditions are AND-joined and OR binds looser than AND, so an OR surviving at depth zero
    is one that pulls the surrounding filters into its arms. One part means the OR is safely
    enclosed, more than one means it is not.
    """
    parts: list[str] = []
    depth = 0
    start = 0
    for i, ch in enumerate(expr):
        if ch == "(":
            depth += 1
        elif ch == ")":
            depth -= 1
        elif depth == 0 and expr.startswith(" OR ", i):
            parts.append(expr[start:i])
            start = i + len(" OR ")
    parts.append(expr[start:])
    return parts


def _metadata_halves(cond: str) -> tuple[str, str]:
    """Return a keyed metadata condition's ``(trace_half, span_half)``.

    Asserts on the way through that the condition is a single parenthesised group whose OR
    is inside it, which is the property that keeps the condition from widening its
    neighbours once the caller ANDs it into the shared WHERE clause.
    """
    assert cond.startswith("(") and cond.endswith(")")
    assert len(_or_parts_at_top_level(cond)) == 1
    parts = _or_parts_at_top_level(cond[1:-1])
    assert len(parts) == 2, f"expected one trace half and one span half, got: {parts}"
    return parts[0], parts[1]


def test_metadata_predicate_matches_the_trace_row_or_any_of_its_spans():
    """A tag the user can see must be filterable wherever the SDK attached it. The trace
    half reads the already-scanned ``t`` row inline; the span half is the semi-join."""
    params = {"project_id": "p1", "start_after": "2026-06-01 00:00:00"}
    conditions = build_conditions([_metadata()], params)

    assert len(conditions) == 1
    trace_half, span_half = _metadata_halves(conditions[0])
    # Trace half: no extra scan, just the row the list already reads — and no time bound of
    # its own, because the outer window has already restricted that row.
    assert "t.metadata_map" in trace_half
    assert "FROM spans" not in trace_half
    assert "span_start_time" not in trace_half
    # Span half: the existing membership semi-join, unchanged.
    assert span_half.startswith("t.trace_id IN (")
    assert "FROM spans" in span_half
    assert "project_id = {project_id:String}" in span_half


def test_a_metadata_predicate_still_constrains_the_filters_beside_it():
    """The consequence of the parenthesisation, stated as behaviour: with a metadata
    predicate in the list, the assembled WHERE clause is still a conjunction, so the
    model_name filter beside it can never be satisfied merely by the metadata match."""
    params = {"project_id": "p1", "start_after": "2026-06-01 00:00:00"}
    conditions = build_conditions(
        [
            Predicate(field="model_name", op="in", value=["gpt-4"]),
            _metadata(key="tenant_id", value="acme-corp"),
        ],
        params,
    )
    where = " AND ".join(conditions)

    assert len(_or_parts_at_top_level(where)) == 1
    # The model_name semi-join is still its own top-level conjunct rather than an OR arm.
    model_cond = next(c for c in conditions if "model_name IN" in c)
    assert len(_or_parts_at_top_level(model_cond)) == 1


def test_metadata_predicate_binds_the_key_and_the_value_as_parameters_in_both_halves():
    """The key is DATA, not an identifier — that is what makes an arbitrary user-typed
    key safe to query without registry membership. Neither slot is interpolated on either
    side, and both halves reference the SAME bound names, so the two can never end up
    comparing different values."""
    params = {"project_id": "p1"}
    cond = build_conditions([_metadata(key="tenant_id", value="acme-corp")], params)[0]
    trace_half, span_half = _metadata_halves(cond)

    assert params["f_metadata_0_key"] == "tenant_id"
    assert params["f_metadata_0"] == "acme-corp"
    assert "tenant_id" not in cond
    assert "acme-corp" not in cond
    assert "t.metadata_map[{f_metadata_0_key:String}] = {f_metadata_0:String}" in trace_half
    assert "metadata_map[{f_metadata_0_key:String}] = {f_metadata_0:String}" in span_half
    # Bound once each, not once per half.
    assert [k for k in params if k.startswith("f_metadata_")] == [
        "f_metadata_0_key",
        "f_metadata_0",
    ]


def test_metadata_predicate_omits_the_span_bound_when_the_list_has_no_start():
    """No window bound to inherit means no span bound emitted — identical to the
    categorical path. (``list_traces`` defaults one whenever filters are present.)"""
    params = {"project_id": "p1"}
    cond = build_conditions([_metadata()], params)[0]

    assert "span_start_time" not in cond


def test_metadata_predicate_guards_an_absent_key_in_both_halves():
    """ClickHouse's map subscript returns the value type's default for an absent key, so
    without ``mapContains`` a filter for the empty string would match every row that never
    carried the key at all. Each half needs its own guard — one guarded half and one
    unguarded half is still a predicate that matches rows it should not."""
    for op in ("eq", "contains"):
        params = {"project_id": "p1"}
        trace_half, span_half = _metadata_halves(build_conditions([_metadata(op=op)], params)[0])

        trace_guard = "mapContains(t.metadata_map, {f_metadata_0_key:String})"
        assert f"{trace_guard} AND " in trace_half
        assert trace_half.index(trace_guard) < trace_half.index(
            "t.metadata_map[{f_metadata_0_key:String}]"
        )

        span_guard = "mapContains(metadata_map, {f_metadata_0_key:String})"
        assert f"{span_guard} AND " in span_half
        assert span_half.index(span_guard) < span_half.index(
            "metadata_map[{f_metadata_0_key:String}]"
        )


def test_metadata_contains_lowers_to_a_parameterized_ilike_in_both_halves():
    params = {"project_id": "p1"}
    trace_half, span_half = _metadata_halves(
        build_conditions([_metadata(op="contains", value="acme")], params)[0]
    )

    assert "t.metadata_map[{f_metadata_0_key:String}] ILIKE {f_metadata_0:String}" in trace_half
    assert "metadata_map[{f_metadata_0_key:String}] ILIKE {f_metadata_0:String}" in span_half
    assert params["f_metadata_0"] == "%acme%"  # case-insensitive substring


def test_metadata_contains_escapes_ilike_wildcards_for_both_halves():
    # A literal % or _ in the search must match literally, the same treatment trace_id's
    # contains gets — otherwise "100%" would match every value containing "100". One bound
    # value serves both halves, so the escaping cannot apply to only one of them.
    params = {"project_id": "p1"}
    trace_half, span_half = _metadata_halves(
        build_conditions([_metadata(op="contains", value="a%b_c")], params)[0]
    )

    assert params["f_metadata_0"] == "%a\\%b\\_c%"
    assert "{f_metadata_0:String}" in trace_half
    assert "{f_metadata_0:String}" in span_half


def test_two_metadata_predicates_on_different_keys_do_not_collide():
    """Independent existence, one condition each, and param names indexed by predicate
    position so the second key/value pair cannot overwrite the first."""
    params = {"project_id": "p1"}
    conditions = build_conditions(
        [
            _metadata(key="tenant_id", value="acme-corp"),
            _metadata(key="release", value="v2026.06"),
        ],
        params,
    )

    assert len(conditions) == 2
    for cond in conditions:
        trace_half, span_half = _metadata_halves(cond)  # both halves survive duplication
        assert "t.metadata_map" in trace_half
        assert span_half.startswith("t.trace_id IN (")
    assert params["f_metadata_0_key"] == "tenant_id"
    assert params["f_metadata_0"] == "acme-corp"
    assert params["f_metadata_1_key"] == "release"
    assert params["f_metadata_1"] == "v2026.06"
    # Each condition references only its own bound pair.
    assert "f_metadata_1" not in conditions[0]
    assert "f_metadata_0" not in conditions[1]


# --- numeric aggregate lowering (explicit operators) -----------------------


@pytest.mark.parametrize(
    "op,token",
    [
        ("eq", "sum(cost) = {"),
        ("gt", "sum(cost) > {"),
        ("gte", "sum(cost) >= {"),
        ("lt", "sum(cost) < {"),
        ("lte", "sum(cost) <= {"),
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
    assert "sum(cost) > {" in cond
    assert "sum(cost) <= {" in cond
    assert " AND " in cond
    assert 1 in params.values() and 10 in params.values()


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


# --- the one span-scan builder ---------------------------------------------
# Keyed, membership and aggregate lowerings all filter through a single deduped scan, so its
# safety properties are asked of all three paths at once rather than once per path.

_SPAN_SCAN_PATHS = {
    "keyed": Predicate(field="metadata", op="eq", value="acme-corp", key="tenant_id"),
    "membership": Predicate(field="model_name", op="in", value=["gpt-4"]),
    "aggregate": Predicate(field="cost", op="gt", value=0.5),
}
_DEDUP = "LIMIT 1 BY project_id, trace_id, span_id"


def _span_scan(pred: Predicate, params: dict) -> str:
    """The span-scan condition one predicate lowers to, keyed condition unwrapped.

    The keyed lowering wraps its scan in an OR with an inline traces-row arm; the other two
    are the bare scan. Unwrapping is what lets one assertion body speak for all three paths.
    """
    cond = build_conditions([pred], params)[0]
    return _metadata_halves(cond)[1] if pred.field == "metadata" else cond


@pytest.mark.parametrize("path", sorted(_SPAN_SCAN_PATHS))
def test_every_span_scan_is_project_scoped(path):
    """Tenant isolation: an unscoped inner relation would let a trace id from another
    project into the semi-join and past the outer query's own project predicate."""
    scan = _span_scan(_SPAN_SCAN_PATHS[path], {"project_id": "p1"})

    assert "FROM spans" in scan
    assert "project_id = {project_id:String}" in scan
    assert scan.startswith("t.trace_id IN (")  # keyed on the outer query, page and count


@pytest.mark.parametrize("path", sorted(_SPAN_SCAN_PATHS))
def test_every_span_scan_is_lower_bounded_with_the_backoff_and_never_upper_bounded(path):
    """The user's date range is the outer bound. Each scan inherits its LOWER bound backed
    off for clock skew, and deliberately takes no upper bound: an in-window trace may have
    matching spans starting after the window's end, and the outer trace-level window
    re-filters the ids anyway, so an upper bound here could only false-negative."""
    params = {
        "project_id": "p1",
        "start_after": "2026-06-01 00:00:00",
        "end_before": "2026-06-02 00:00:00",
    }

    scan = _span_scan(_SPAN_SCAN_PATHS[path], params)

    assert (
        f"span_start_time >= {{start_after:DateTime64(3)}} - INTERVAL "
        f"{SPAN_TIME_BOUND_LOOKBACK_HOURS} HOUR" in scan
    )
    assert "span_start_time <" not in scan
    assert "end_before" not in scan


@pytest.mark.parametrize("path", sorted(_SPAN_SCAN_PATHS))
def test_every_span_scan_dedups_before_its_predicate_runs(path):
    """ReplacingMergeTree keeps superseded span versions until a merge, so a scan that
    filters before deduping can match a value the latest version no longer carries. The
    dedup therefore sits in the inner relation and the tail — a WHERE for the existence
    paths, a GROUP BY ... HAVING for the aggregate — runs above it."""
    scan = _span_scan(_SPAN_SCAN_PATHS[path], {"project_id": "p1"})

    assert "ORDER BY ch_update_time DESC" in scan
    assert _DEDUP in scan
    tail_start = min(
        i for i in (scan.find("WHERE ", scan.index(_DEDUP)), scan.find("GROUP BY ")) if i != -1
    )
    assert scan.index(_DEDUP) < tail_start


def test_the_three_span_scans_share_one_inner_relation():
    """One builder, so the properties above are a single-site question: the keyed,
    membership and aggregate scans differ only in the projected value columns and the
    tail, and are otherwise character-identical."""
    scans = {
        path: _span_scan(pred, {"project_id": "p1", "start_after": "2026-06-01 00:00:00"})
        for path, pred in _SPAN_SCAN_PATHS.items()
    }
    # Everything from the source table to the end of the dedup is the shared relation.
    skeletons = {
        scan[scan.index("FROM spans") : scan.index(_DEDUP) + len(_DEDUP)] for scan in scans.values()
    }
    assert len(skeletons) == 1


# --- a whole filter list at once -------------------------------------------
# A real request spans several tiers and the translator walks it in one pass, so the list as
# a whole is the unit worth asserting on: how many conditions come out of how many
# predicates, that bound parameters follow the predicate rather than the condition's
# position, and that a bad predicate anywhere still stops the whole thing.

_HAVING = "GROUP BY trace_id HAVING"


def test_the_merged_aggregate_condition_is_emitted_after_the_per_predicate_ones():
    """Aggregate predicates are the one tier that cannot lower where it stands — they all
    fold into a single GROUP BY ... HAVING scan, which can only be built once the whole
    list has been walked. So an aggregate predicate sent FIRST still yields its condition
    last, and its bound parameter keeps the index of its position in the REQUEST, not the
    index of the condition it ended up in — the two are deliberately decoupled."""
    params = {"project_id": "p1"}
    conditions = build_conditions(
        [
            Predicate(field="cost", op="gt", value=1),
            Predicate(field="model_name", op="in", value=["gpt-4"]),
            Predicate(field="trace_id", op="eq", value="abc123"),
        ],
        params,
    )

    assert len(conditions) == 3
    assert _HAVING in conditions[-1]
    assert [c for c in conditions if _HAVING in c] == [conditions[-1]]
    # The cost predicate sat at request position 0 even though its condition is last.
    assert params["f_cost_0"] == 1
    assert "{f_cost_0:Decimal64(9)}" in conditions[-1]


def test_a_filter_list_spanning_every_tier_merges_only_its_aggregates():
    """Five predicates across all four registry levels lower to four conditions: one each
    for the trace-row, membership and keyed-map predicates, and ONE for both aggregates
    together. Merging matters beyond condition count — two aggregate predicates lowered
    separately would be two independent span roll-ups, so "cost > 1 AND errors >= 2" would
    match a trace satisfying each in isolation instead of both at once."""
    params = {"project_id": "p1"}
    conditions = build_conditions(
        [
            Predicate(field="trace_id", op="eq", value="abc123"),
            Predicate(field="cost", op="gt", value=1),
            Predicate(field="model_name", op="in", value=["gpt-4"]),
            _metadata(key="tenant_id", value="acme-corp"),
            Predicate(field="errors", op="gte", value=2),
        ],
        params,
    )

    assert len(conditions) == 4
    aggregates = [c for c in conditions if _HAVING in c]
    assert len(aggregates) == 1
    # Both comparisons in the one HAVING, so a trace must satisfy them simultaneously.
    assert "sum(cost) > {f_cost_1:Decimal64(9)}" in aggregates[0]
    assert "countIf(status = 'ERROR') >= {f_errors_4:UInt64}" in aggregates[0]
    # The merged scan projects both fields' source_columns, still registry-driven.
    scan = aggregates[0]
    inner = scan[scan.index("SELECT", scan.index("SELECT") + 1) : scan.index("FROM spans")]
    assert "cost" in inner and "status" in inner
    # The other three lowered independently, one per predicate.
    others = [c for c in conditions if _HAVING not in c]
    assert "t.trace_id = {f_trace_id_0:String}" in others
    assert len([c for c in others if "model_name IN" in c]) == 1
    assert len([c for c in others if "t.metadata_map" in c]) == 1


_VALID_PREFIX = (
    Predicate(field="trace_id", op="eq", value="abc123"),
    Predicate(field="model_name", op="in", value=["gpt-4"]),
    Predicate(field="cost", op="gt", value=1),
    Predicate(field="metadata", op="eq", value="acme-corp", key="tenant_id"),
)


@pytest.mark.parametrize(
    "bad",
    [
        pytest.param(Predicate(field="not_a_field", op="eq", value="x"), id="unknown-field"),
        pytest.param(Predicate(field="cost", op="in", value=["1"]), id="operator-off-whitelist"),
        pytest.param(Predicate(field="model_name", op="in", value=[]), id="empty-in-list"),
        pytest.param(Predicate(field="metadata", op="eq", value="x"), id="keyed-field-no-key"),
        pytest.param(
            Predicate(field="trace_id", op="eq", value="x", key="tenant_id"),
            id="key-on-unkeyed-field",
        ),
    ],
)
def test_a_bad_predicate_is_rejected_however_many_valid_ones_precede_it(bad):
    """Validation is the registry safety boundary, and it has to hold for every predicate
    in the list, not just the first. The prefix here covers all four tiers — including the
    aggregate one, whose predicates take a different route through the translator — so a
    bad predicate can't slip past by sitting behind them and no partial condition list is
    returned in its place."""
    assert len(build_conditions(list(_VALID_PREFIX), {"project_id": "p1"})) == 4

    with pytest.raises(ValueError):
        build_conditions([*_VALID_PREFIX, bad], {"project_id": "p1"})


def test_no_two_predicates_in_a_list_bind_the_same_parameter_name():
    """Every value reaches ClickHouse as a bound parameter in a single flat map shared by
    the page and the count query, so two predicates binding one name is not a SQL error —
    it is the second value silently answering for the first. Names carry the predicate's
    request position, which stays unique across repeats of a field and across tiers even
    though the conditions are now emitted interleaved."""
    params = {"project_id": "p1"}
    conditions = build_conditions(
        [
            Predicate(field="trace_id", op="eq", value="abc123"),
            Predicate(field="cost", op="gt", value=1),
            Predicate(field="model_name", op="in", value=["gpt-4"]),
            Predicate(field="cost", op="lt", value=9),
            _metadata(key="tenant_id", value="acme-corp"),
        ],
        params,
    )

    bound = {k: v for k, v in params.items() if k.startswith("f_")}
    assert bound == {
        "f_trace_id_0": "abc123",
        "f_cost_1": 1,
        "f_model_name_2": ["gpt-4"],
        "f_cost_3": 9,
        "f_metadata_4_key": "tenant_id",
        "f_metadata_4": "acme-corp",
    }
    # Both cost bounds survive into the one HAVING rather than one overwriting the other.
    aggregate = next(c for c in conditions if _HAVING in c)
    assert "{f_cost_1:Decimal64(9)}" in aggregate and "{f_cost_3:Decimal64(9)}" in aggregate


# --- every registry level has a lowering -----------------------------------


def _valid_predicate_for(col: FilterColumn) -> Predicate:
    """A minimally valid predicate for any registry column, derived from what the column
    declares, so a newly registered field is exercised without editing this test."""
    value = {FilterType.CATEGORICAL: ["x"], FilterType.NUMERIC: 1, FilterType.TEXT: "x"}[col.type]
    return Predicate(
        field=col.name,
        op=col.operators[0],
        value=value,
        key="some_key" if col.requires_key else None,
    )


def test_every_registered_field_lowers_rather_than_raising_not_implemented():
    """The registry is what ``/filter-fields`` offers the UI, so a field whose level the
    translator has no lowering for is a filter the user can build and a 500 when they
    apply it. Walking the real registry makes that a test failure the moment a field is
    added on a level nobody wired up, instead of a runtime error in production."""
    for col in FILTER_COLUMNS:
        conditions = build_conditions([_valid_predicate_for(col)], {"project_id": "p1"})
        assert len(conditions) == 1, f"{col.name} ({col.level}) produced {conditions}"


def test_a_level_with_no_lowering_raises_not_implemented_naming_the_level_and_field(monkeypatch):
    """The lowering table is a dict lookup, so an unhandled level must not surface as a
    bare KeyError or, worse, a skipped predicate — a dropped condition would widen the
    result set silently. The error has to name both the level and the field, since that is
    all a responder gets to identify which registry entry is unwired."""
    unlowered = FilterColumn(
        name="future_field",
        label="Future",
        ch_type="String",
        level="SPAN_WINDOW",  # a level no lowering handles
        type=FilterType.TEXT,
        operators=(FilterOperator.EQ,),
        value_source=ValueSource.FREE_TEXT,
    )
    monkeypatch.setattr(translate, "get_column", lambda name: unlowered)

    with pytest.raises(NotImplementedError) as excinfo:
        build_conditions(
            [Predicate(field="future_field", op="eq", value="x")], {"project_id": "p1"}
        )

    assert "SPAN_WINDOW" in str(excinfo.value)
    assert "future_field" in str(excinfo.value)
