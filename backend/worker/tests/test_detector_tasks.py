"""Tests for detector trigger condition evaluation."""

from unittest.mock import MagicMock, patch

from worker.detector_tasks import _eval_condition, _get_trace_summaries, _passes_trigger

# ── Tests for _eval_condition ──────────────────────────────────────


def test_eval_condition_equality_operator():
    """Test equality operator (=)."""
    trace_summary = {"environment": "production"}
    condition = {"field": "environment", "op": "=", "value": "production"}
    assert _eval_condition(trace_summary, condition) is True


def test_eval_condition_equality_operator_fail():
    """Test equality operator fails when values differ."""
    trace_summary = {"environment": "staging"}
    condition = {"field": "environment", "op": "=", "value": "production"}
    assert _eval_condition(trace_summary, condition) is False


def test_eval_condition_not_equal_operator():
    """Test inequality operator (!=)."""
    trace_summary = {"environment": "staging"}
    condition = {"field": "environment", "op": "!=", "value": "production"}
    assert _eval_condition(trace_summary, condition) is True


def test_eval_condition_not_equal_operator_fail():
    """Test inequality operator fails when values are equal."""
    trace_summary = {"environment": "production"}
    condition = {"field": "environment", "op": "!=", "value": "production"}
    assert _eval_condition(trace_summary, condition) is False


def test_eval_condition_greater_than():
    """Test greater than operator (>)."""
    trace_summary = {"cost": 100.5}
    condition = {"field": "cost", "op": ">", "value": 50.0}
    assert _eval_condition(trace_summary, condition) is True


def test_eval_condition_greater_than_fail():
    """Test greater than operator fails when value is smaller."""
    trace_summary = {"cost": 30.0}
    condition = {"field": "cost", "op": ">", "value": 50.0}
    assert _eval_condition(trace_summary, condition) is False


def test_eval_condition_greater_than_or_equal():
    """Test greater than or equal operator (>=)."""
    trace_summary = {"cost": 50.0}
    condition = {"field": "cost", "op": ">=", "value": 50.0}
    assert _eval_condition(trace_summary, condition) is True


def test_eval_condition_greater_than_or_equal_fail():
    """Test greater than or equal operator fails when value is smaller."""
    trace_summary = {"cost": 49.9}
    condition = {"field": "cost", "op": ">=", "value": 50.0}
    assert _eval_condition(trace_summary, condition) is False


def test_eval_condition_less_than():
    """Test less than operator (<)."""
    trace_summary = {"tokens": 500}
    condition = {"field": "tokens", "op": "<", "value": 1000}
    assert _eval_condition(trace_summary, condition) is True


def test_eval_condition_less_than_fail():
    """Test less than operator fails when value is larger."""
    trace_summary = {"tokens": 1500}
    condition = {"field": "tokens", "op": "<", "value": 1000}
    assert _eval_condition(trace_summary, condition) is False


def test_eval_condition_less_than_or_equal():
    """Test less than or equal operator (<=)."""
    trace_summary = {"tokens": 1000}
    condition = {"field": "tokens", "op": "<=", "value": 1000}
    assert _eval_condition(trace_summary, condition) is True


def test_eval_condition_less_than_or_equal_fail():
    """Test less than or equal operator fails when value is larger."""
    trace_summary = {"tokens": 1001}
    condition = {"field": "tokens", "op": "<=", "value": 1000}
    assert _eval_condition(trace_summary, condition) is False


def test_eval_condition_missing_field():
    """Missing field in trace_summary returns False."""
    trace_summary = {}
    condition = {"field": "cost", "op": ">", "value": 50.0}
    assert _eval_condition(trace_summary, condition) is False


def test_eval_condition_unknown_operator():
    """Unknown operator returns False."""
    trace_summary = {"cost": 100.0}
    condition = {"field": "cost", "op": "unknown_op", "value": 50.0}
    assert _eval_condition(trace_summary, condition) is False


def test_eval_condition_numeric_strings_in_comparisons():
    """Numeric operators convert string values correctly."""
    trace_summary = {"cost": "100.5"}
    condition = {"field": "cost", "op": ">", "value": "50.0"}
    assert _eval_condition(trace_summary, condition) is True


# ── Tests for _passes_trigger ──────────────────────────────────────


def test_passes_trigger_empty_conditions():
    """Empty conditions list returns True (always passes)."""
    trace_summary = {"environment": "staging"}
    conditions = []
    assert _passes_trigger(trace_summary, conditions) is True


def test_passes_trigger_all_conditions_pass():
    """All conditions pass returns True."""
    trace_summary = {"environment": "production", "cost": 100.0, "tokens": 5000}
    conditions = [
        {"field": "environment", "op": "=", "value": "production"},
        {"field": "cost", "op": ">", "value": 50.0},
        {"field": "tokens", "op": ">=", "value": 5000},
    ]
    assert _passes_trigger(trace_summary, conditions) is True


def test_passes_trigger_one_condition_fails():
    """One failing condition makes entire trigger fail."""
    trace_summary = {"environment": "production", "cost": 30.0, "tokens": 5000}
    conditions = [
        {"field": "environment", "op": "=", "value": "production"},
        {"field": "cost", "op": ">", "value": 50.0},  # This will fail
        {"field": "tokens", "op": ">=", "value": 5000},
    ]
    assert _passes_trigger(trace_summary, conditions) is False


def test_passes_trigger_missing_field_fails():
    """Missing field in a condition causes trigger to fail."""
    trace_summary = {"environment": "production"}
    conditions = [
        {"field": "environment", "op": "=", "value": "production"},
        {"field": "missing_field", "op": "=", "value": "some_value"},
    ]
    assert _passes_trigger(trace_summary, conditions) is False


def test_passes_trigger_legacy_status_condition_is_inert():
    """Legacy status conditions no longer fire because summaries omit trace status."""
    trace_summary = {"environment": "production"}
    conditions = [{"field": "status", "op": "=", "value": "ERROR"}]
    assert _passes_trigger(trace_summary, conditions) is False


def test_passes_trigger_single_condition_passes():
    """Single condition that passes returns True."""
    trace_summary = {"cost": 100.0}
    conditions = [{"field": "cost", "op": ">", "value": 50.0}]
    assert _passes_trigger(trace_summary, conditions) is True


# ── Fail-closed source guard ───────────────────────────────────────


def test_trace_summaries_query_scopes_to_user_source():
    """The judge's read names the one source that IS customer traffic, never the
    fail-open inequality against the detector marker."""
    ch = MagicMock()
    ch.query.return_value = MagicMock(result_rows=[])
    with patch("db.clickhouse.client.get_clickhouse_client", return_value=ch):
        _get_trace_summaries("p1", ["t1"], include_trace_metadata=False)
    sql = ch.query.call_args_list[0].args[0]
    assert "AND source = 'user'" in sql
    assert "!= 'detector'" not in sql

# ── Tests for _eval_membership (multi-valued span fields) ─────────────────────


def test_eval_membership_equality_hit():
    """= on a list field returns True when the value is present."""
    trace_summary = {"model_name": ["gpt-4o", "gpt-4o-mini"]}
    condition = {"field": "model_name", "op": "=", "value": "gpt-4o"}
    assert _eval_condition(trace_summary, condition) is True


def test_eval_membership_equality_miss():
    """= on a list field returns False when the value is absent."""
    trace_summary = {"model_name": ["gpt-4o-mini"]}
    condition = {"field": "model_name", "op": "=", "value": "gpt-4o"}
    assert _eval_condition(trace_summary, condition) is False


def test_eval_membership_not_equal_hit():
    """!= on a list field returns True when the value is absent from all spans."""
    trace_summary = {"model_name": ["gpt-4o-mini"]}
    condition = {"field": "model_name", "op": "!=", "value": "gpt-4o"}
    assert _eval_condition(trace_summary, condition) is True


def test_eval_membership_not_equal_miss():
    """!= on a list field returns False when the value appears in at least one span."""
    trace_summary = {"model_name": ["gpt-4o", "gpt-4o-mini"]}
    condition = {"field": "model_name", "op": "!=", "value": "gpt-4o"}
    assert _eval_condition(trace_summary, condition) is False


def test_eval_membership_contains_hit():
    """contains on a list field matches a substring in any span value."""
    trace_summary = {"model_name": ["gpt-4o-mini", "claude-3-5-sonnet"]}
    condition = {"field": "model_name", "op": "contains", "value": "gpt"}
    assert _eval_condition(trace_summary, condition) is True


def test_eval_membership_contains_miss():
    """contains on a list field returns False when no span value has the substring."""
    trace_summary = {"model_name": ["claude-3-5-sonnet", "claude-3-haiku"]}
    condition = {"field": "model_name", "op": "contains", "value": "gpt"}
    assert _eval_condition(trace_summary, condition) is False


def test_eval_membership_contains_case_insensitive():
    """contains is case-insensitive on list fields."""
    trace_summary = {"model_name": ["GPT-4O"]}
    condition = {"field": "model_name", "op": "contains", "value": "gpt"}
    assert _eval_condition(trace_summary, condition) is True


def test_eval_membership_empty_list():
    """= on an empty list always returns False."""
    trace_summary = {"model_name": []}
    condition = {"field": "model_name", "op": "=", "value": "gpt-4o"}
    assert _eval_condition(trace_summary, condition) is False


def test_eval_membership_unknown_op():
    """An unknown operator on a list field returns False without raising."""
    trace_summary = {"model_name": ["gpt-4o"]}
    condition = {"field": "model_name", "op": "startswith", "value": "gpt"}
    assert _eval_condition(trace_summary, condition) is False


# ── Edge cases for _eval_condition ────────────────────────────────────────────


def test_eval_condition_malformed_condition_string():
    """A bare string instead of a dict evaluates False without raising."""
    trace_summary = {"environment": "production"}
    assert _eval_condition(trace_summary, "environment = production") is False


def test_eval_condition_none_value_in_list():
    """None entries in a list field are skipped safely by contains."""
    trace_summary = {"model_name": [None, "gpt-4o"]}
    condition = {"field": "model_name", "op": "contains", "value": "gpt"}
    assert _eval_condition(trace_summary, condition) is True


def test_eval_condition_non_string_contains_needle():
    """contains with a non-string needle coerces it via str() before matching."""
    trace_summary = {"model_name": ["version-4"]}
    condition = {"field": "model_name", "op": "contains", "value": 4}
    assert _eval_condition(trace_summary, condition) is True


def test_eval_condition_missing_field_key():
    """condition dict with no 'field' key evaluates False without raising."""
    trace_summary = {"environment": "production"}
    condition = {"op": "=", "value": "production"}
    assert _eval_condition(trace_summary, condition) is False