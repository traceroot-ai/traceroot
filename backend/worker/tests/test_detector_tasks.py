"""Tests for detector trigger evaluation and BullMQ enqueue."""

import json
from unittest.mock import MagicMock

from worker.detector_tasks import _enqueue_to_bullmq, _eval_condition, _passes_trigger

# ── Tests for _eval_condition ──────────────────────────────────────


def test_eval_condition_equality_operator():
    """Test equality operator (=)."""
    trace_summary = {"status": "completed"}
    condition = {"field": "status", "op": "=", "value": "completed"}
    assert _eval_condition(trace_summary, condition) is True


def test_eval_condition_equality_operator_fail():
    """Test equality operator fails when values differ."""
    trace_summary = {"status": "pending"}
    condition = {"field": "status", "op": "=", "value": "completed"}
    assert _eval_condition(trace_summary, condition) is False


def test_eval_condition_not_equal_operator():
    """Test inequality operator (!=)."""
    trace_summary = {"status": "pending"}
    condition = {"field": "status", "op": "!=", "value": "completed"}
    assert _eval_condition(trace_summary, condition) is True


def test_eval_condition_not_equal_operator_fail():
    """Test inequality operator fails when values are equal."""
    trace_summary = {"status": "completed"}
    condition = {"field": "status", "op": "!=", "value": "completed"}
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
    trace_summary = {"status": "pending"}
    conditions = []
    assert _passes_trigger(trace_summary, conditions) is True


def test_passes_trigger_all_conditions_pass():
    """All conditions pass returns True."""
    trace_summary = {"status": "completed", "cost": 100.0, "tokens": 5000}
    conditions = [
        {"field": "status", "op": "=", "value": "completed"},
        {"field": "cost", "op": ">", "value": 50.0},
        {"field": "tokens", "op": ">=", "value": 5000},
    ]
    assert _passes_trigger(trace_summary, conditions) is True


def test_passes_trigger_one_condition_fails():
    """One failing condition makes entire trigger fail."""
    trace_summary = {"status": "completed", "cost": 30.0, "tokens": 5000}
    conditions = [
        {"field": "status", "op": "=", "value": "completed"},
        {"field": "cost", "op": ">", "value": 50.0},  # This will fail
        {"field": "tokens", "op": ">=", "value": 5000},
    ]
    assert _passes_trigger(trace_summary, conditions) is False


def test_passes_trigger_missing_field_fails():
    """Missing field in a condition causes trigger to fail."""
    trace_summary = {"status": "completed"}
    conditions = [
        {"field": "status", "op": "=", "value": "completed"},
        {"field": "missing_field", "op": "=", "value": "some_value"},
    ]
    assert _passes_trigger(trace_summary, conditions) is False


def test_passes_trigger_single_condition_passes():
    """Single condition that passes returns True."""
    trace_summary = {"cost": 100.0}
    conditions = [{"field": "cost", "op": ">", "value": 50.0}]
    assert _passes_trigger(trace_summary, conditions) is True


# ── Tests for _enqueue_to_bullmq ───────────────────────────────────


def test_enqueue_to_bullmq_calls_rpush_with_correct_key():
    """_enqueue_to_bullmq calls rpush with correct queue key and job_id."""
    redis_client = MagicMock()
    queue_name = "detector-eval"
    job_id = "detector-1--trace-abc"
    data = {"traceId": "trace-abc", "detectorId": "detector-1"}

    _enqueue_to_bullmq(redis_client, queue_name, job_id, data)

    # Verify rpush was called with the queue key and job_id string
    redis_client.rpush.assert_called_once()
    call_args = redis_client.rpush.call_args
    assert call_args[0][0] == f"bull:{queue_name}:wait"
    assert call_args[0][1] == job_id


def test_enqueue_to_bullmq_payload_structure():
    """_enqueue_to_bullmq stores job payload in a Redis hash with correct structure."""
    redis_client = MagicMock()
    queue_name = "detector-eval"
    job_id = "detector-1--trace-abc"
    data = {"traceId": "trace-abc", "detectorId": "detector-1", "projectId": "proj-1"}

    _enqueue_to_bullmq(redis_client, queue_name, job_id, data)

    # Verify hset was called with the correct hash key and mapping
    redis_client.hset.assert_called_once()
    hset_call = redis_client.hset.call_args
    assert hset_call[0][0] == f"bull:{queue_name}:{job_id}"
    mapping = hset_call[1]["mapping"]

    # Verify the hash fields
    assert mapping["name"] == "detect"
    assert json.loads(mapping["data"]) == data
    opts = json.loads(mapping["opts"])
    assert opts["jobId"] == job_id
    assert opts["removeOnComplete"] == 100
    assert opts["removeOnFail"] == 50


def test_enqueue_to_bullmq_multiple_queues():
    """_enqueue_to_bullmq correctly formats different queue names."""
    redis_client = MagicMock()
    queue_name_1 = "detector-eval"
    queue_name_2 = "custom-queue"

    _enqueue_to_bullmq(redis_client, queue_name_1, "job-1", {"data": "1"})
    _enqueue_to_bullmq(redis_client, queue_name_2, "job-2", {"data": "2"})

    # Check both rpush calls use the correct queue wait keys
    calls = redis_client.rpush.call_args_list
    assert len(calls) == 2
    assert calls[0][0][0] == f"bull:{queue_name_1}:wait"
    assert calls[1][0][0] == f"bull:{queue_name_2}:wait"
