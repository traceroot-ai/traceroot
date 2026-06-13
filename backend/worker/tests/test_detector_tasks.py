"""Tests for detector trigger condition evaluation."""

from worker.detector_tasks import _eval_condition, _passes_trigger

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
