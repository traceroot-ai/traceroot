"""Tests for trigger eligibility after a trace has settled."""

from unittest.mock import MagicMock

import pytest
from fastapi.testclient import TestClient

from rest.main import app
from shared.config import settings
from worker import detector_tasks as dt


@pytest.fixture()
def secret(monkeypatch):
    monkeypatch.setattr(settings, "internal_api_secret", "test-secret")
    return "test-secret"


@pytest.fixture()
def client(secret):
    return TestClient(app)


TRACE = "trace-a"
URL = "/api/v1/internal/traces/trace-a/eligible-detectors"


def _detector(detector_id, conditions):
    return {"id": detector_id, "sample_rate": 100, "conditions": conditions}


def test_returns_only_queued_detectors_matching_the_latest_summary(client, secret, monkeypatch):
    detectors = [
        _detector("late-error", [{"field": "errors", "op": ">", "value": 0}]),
        _detector(
            "wrong-environment", [{"field": "environment", "op": "=", "value": "production"}]
        ),
        _detector("not-queued", []),
    ]
    monkeypatch.setattr(dt, "_get_active_detectors", lambda project_id: detectors)
    summary_reader = MagicMock(
        return_value={
            "trace-a": {
                "errors": 1,
                "environment": ["staging"],
                "is_evaluation": False,
            }
        }
    )
    monkeypatch.setattr(dt, "_get_trace_summaries", summary_reader)

    response = client.get(
        URL,
        params=[
            ("project_id", "p1"),
            ("detector_ids", "late-error"),
            ("detector_ids", "wrong-environment"),
            ("detector_ids", "not-present"),
        ],
        headers={"X-Internal-Secret": secret},
    )

    assert response.status_code == 200
    assert response.json() == {"detector_ids": ["late-error"]}
    summary_reader.assert_called_once_with("p1", ["trace-a"], include_trace_metadata=False)


def test_empty_customer_summary_fails_closed(client, secret, monkeypatch):
    monkeypatch.setattr(
        dt,
        "_get_active_detectors",
        lambda project_id: [_detector("d1", [])],
    )
    monkeypatch.setattr(dt, "_get_trace_summaries", lambda *args, **kwargs: {})

    response = client.get(
        URL,
        params=[("project_id", "p1"), ("detector_ids", "d1")],
        headers={"X-Internal-Secret": secret},
    )

    assert response.status_code == 200
    assert response.json() == {"detector_ids": []}


def test_evaluation_traces_remain_excluded(client, secret, monkeypatch):
    monkeypatch.setattr(
        dt,
        "_get_active_detectors",
        lambda project_id: [_detector("d1", [])],
    )
    monkeypatch.setattr(
        dt,
        "_get_trace_summaries",
        lambda *args, **kwargs: {"trace-a": {"is_evaluation": True}},
    )

    response = client.get(
        URL,
        params=[("project_id", "p1"), ("detector_ids", "d1")],
        headers={"X-Internal-Secret": secret},
    )

    assert response.status_code == 200
    assert response.json() == {"detector_ids": []}


def test_requires_internal_secret(client):
    response = client.get(URL, params=[("project_id", "p1"), ("detector_ids", "d1")])
    assert response.status_code == 403


def test_empty_candidate_list_returns_no_detectors(client, secret, monkeypatch):
    """No queued candidates means nothing to evaluate; the endpoint must not
    touch the detector registry or ClickHouse at all."""
    active = MagicMock()
    monkeypatch.setattr(dt, "_get_active_detectors", active)
    summaries = MagicMock()
    monkeypatch.setattr(dt, "_get_trace_summaries", summaries)

    response = client.get(
        URL,
        params=[("project_id", "p1")],
        headers={"X-Internal-Secret": secret},
    )

    assert response.status_code == 200
    assert response.json() == {"detector_ids": []}
    active.assert_not_called()
    summaries.assert_not_called()


def test_inactive_or_deleted_detector_ids_return_no_detectors(client, secret, monkeypatch):
    """A candidate that was deleted or disabled between enqueue and settlement
    must not be evaluated, and must not make the endpoint query ClickHouse."""
    active = MagicMock(return_value=[_detector("still-active", [])])
    monkeypatch.setattr(dt, "_get_active_detectors", active)
    summaries = MagicMock(return_value={TRACE: {"is_evaluation": False}})
    monkeypatch.setattr(dt, "_get_trace_summaries", summaries)

    response = client.get(
        URL,
        params=[
            ("project_id", "p1"),
            ("detector_ids", "deleted-detector"),
            ("detector_ids", "still-active"),
        ],
        headers={"X-Internal-Secret": secret},
    )

    assert response.status_code == 200
    assert response.json() == {"detector_ids": ["still-active"]}
    summaries.assert_called_once_with("p1", [TRACE], include_trace_metadata=False)


def test_all_candidates_inactive_returns_no_detectors(client, secret, monkeypatch):
    """Every requested candidate deleted or disabled: the endpoint returns empty
    and never reads the trace summary."""
    active = MagicMock(return_value=[])
    monkeypatch.setattr(dt, "_get_active_detectors", active)
    summaries = MagicMock()
    monkeypatch.setattr(dt, "_get_trace_summaries", summaries)

    response = client.get(
        URL,
        params=[("project_id", "p1"), ("detector_ids", "deleted")],
        headers={"X-Internal-Secret": secret},
    )

    assert response.status_code == 200
    assert response.json() == {"detector_ids": []}
    summaries.assert_not_called()


def test_duplicate_candidate_ids_are_evaluated_once(client, secret, monkeypatch):
    """A duplicate detector id in the query must not be evaluated or returned twice."""
    detector = _detector("dup", [{"field": "errors", "op": ">", "value": 0}])
    monkeypatch.setattr(dt, "_get_active_detectors", lambda project_id: [detector])
    monkeypatch.setattr(
        dt,
        "_get_trace_summaries",
        lambda *args, **kwargs: {TRACE: {"errors": 1, "is_evaluation": False}},
    )

    response = client.get(
        URL,
        params=[
            ("project_id", "p1"),
            ("detector_ids", "dup"),
            ("detector_ids", "dup"),
        ],
        headers={"X-Internal-Secret": secret},
    )

    assert response.status_code == 200
    assert response.json() == {"detector_ids": ["dup"]}


class _FakeRedis:
    """Minimal Redis stand-in for the enqueue NX claim."""

    def __init__(self):
        self.store: dict[str, bytes] = {}

    def set(self, key, value, nx=False, ex=None):
        if isinstance(value, str):
            value = value.encode()
        if nx and key in self.store:
            return None
        self.store[key] = value
        return True

    def eval(self, script, numkeys, key, expected):
        expected_bytes = expected.encode() if isinstance(expected, str) else expected
        if self.store.get(key) == expected_bytes:
            del self.store[key]
            return 1
        return 0


class _StatefulSummaries:
    """Hand back the root-time summary on the first read and the settled summary
    on the second, recording what it returned so a test can prove the two reads
    are distinct."""

    def __init__(self, root_summary, settled_summary):
        self.root_summary = root_summary
        self.settled_summary = settled_summary
        self.returned: list[dict] = []

    def __call__(self, project_id, trace_ids, *, include_trace_metadata=True):
        summary = self.root_summary if not self.returned else self.settled_summary
        self.returned.append(summary)
        return {trace_ids[0]: summary}


def test_late_qualifying_span_is_evaluated_against_the_settled_summary(client, secret, monkeypatch):
    """Root arrival sees errors: 0 and only samples the detector; a later child
    span makes the settled summary errors: 1. The detector must be enqueued as a
    candidate at root arrival and then deemed eligible against the settled
    summary. This fails if eligibility is evaluated against the stale root-time
    summary, which has no errors and would return an empty result."""
    detector = _detector("late-error", [{"field": "errors", "op": ">", "value": 0}])
    monkeypatch.setattr(dt, "_get_active_detectors", lambda project_id: [detector])

    summaries = _StatefulSummaries(
        {"errors": 0, "is_evaluation": False},
        {"errors": 1, "is_evaluation": False},
    )
    monkeypatch.setattr(dt, "_get_trace_summaries", summaries)

    redis = _FakeRedis()
    monkeypatch.setattr(dt, "_get_redis", lambda: redis)
    added: list[dict] = []
    monkeypatch.setattr(dt, "_add_bullmq_job", lambda job_id, data: added.append(data))

    # Root-bearing batch: the detector is sampled even though the root-time
    # summary has no errors, so eligibility is not frozen at root arrival.
    dt.enqueue_detector_runs("p1", {TRACE})

    assert added == [{"traceId": TRACE, "detectorIds": ["late-error"], "projectId": "p1"}]
    assert summaries.returned[0]["errors"] == 0

    response = client.get(
        URL,
        params=[("project_id", "p1"), ("detector_ids", "late-error")],
        headers={"X-Internal-Secret": secret},
    )

    assert response.status_code == 200
    assert response.json() == {"detector_ids": ["late-error"]}
    # The eligibility read is the settled summary (errors: 1), not the root-time one.
    assert summaries.returned[1]["errors"] == 1


def test_still_clean_settled_trace_is_not_evaluated(client, secret, monkeypatch):
    """Negative control: the trace never gains an error, so the settled summary
    still has errors: 0 and the detector must not be evaluated."""
    detector = _detector("late-error", [{"field": "errors", "op": ">", "value": 0}])
    monkeypatch.setattr(dt, "_get_active_detectors", lambda project_id: [detector])
    monkeypatch.setattr(
        dt,
        "_get_trace_summaries",
        lambda *args, **kwargs: {TRACE: {"errors": 0, "is_evaluation": False}},
    )

    response = client.get(
        URL,
        params=[("project_id", "p1"), ("detector_ids", "late-error")],
        headers={"X-Internal-Secret": secret},
    )

    assert response.status_code == 200
    assert response.json() == {"detector_ids": []}


def test_malformed_condition_excludes_only_its_own_detector(client, secret, monkeypatch):
    """A malformed condition must disable its own detector only; the other
    queued detector is still evaluated against the settled summary."""
    detectors = [
        _detector("legacy", [None]),
        _detector("healthy", [{"field": "environment", "op": "=", "value": "prod"}]),
    ]
    monkeypatch.setattr(dt, "_get_active_detectors", lambda project_id: detectors)
    monkeypatch.setattr(
        dt,
        "_get_trace_summaries",
        lambda *args, **kwargs: {TRACE: {"environment": ["prod"], "is_evaluation": False}},
    )

    response = client.get(
        URL,
        params=[
            ("project_id", "p1"),
            ("detector_ids", "legacy"),
            ("detector_ids", "healthy"),
        ],
        headers={"X-Internal-Secret": secret},
    )

    assert response.status_code == 200
    assert response.json() == {"detector_ids": ["healthy"]}
