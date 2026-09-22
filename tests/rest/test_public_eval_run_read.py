"""Integration tests for the public evaluation run-summary read.

These exercise the REAL API-key dependency and the ``read_run`` route end to end,
mocking the Next.js side with ``respx``. Evaluation runs live in Postgres/Prisma,
so the read is delegated to the secret-authed ``project-evaluations`` internal
route, keyed by the project the key resolved — not forwarded to the API-key
control-plane route. Client errors the internal route owns (400/403/404) pass
through; everything ambiguous fails closed as a 503.
"""

import json

import httpx
import respx
from fastapi.testclient import TestClient
from httpx import Response

from rest.main import app

BASE_URL = "http://localhost:3000"
INTERNAL_URL = f"{BASE_URL}/api/internal/project-evaluations"

KEY_HEADER = {"Authorization": "Bearer tr-some-key"}

KEY_OK_BODY = {
    "valid": True,
    "projectId": "proj-A",
    "workspaceId": "ws-1",
    "billingPlan": "free",
    "ingestionBlocked": False,
}

SUMMARY = {
    "evaluation_run_id": "run1",
    "evaluation_id": "eval1",
    "evaluation_name": "Billing routing",
    "evaluation_key": "billing-routing",
    "run_number": 2,
    "candidate_version": "sonnet",
    "environment": "evaluation",
    "status": "completed",
    "started_at": "2026-09-14T00:00:00.000Z",
    "completed_at": "2026-09-14T00:00:05.000Z",
    "dataset_id": "ds-client",
    "dataset_version_id": "dv1",
    "run_path": "/projects/proj-A/evaluations/run1",
    "run_url": "http://localhost:3000/projects/proj-A/evaluations/run1",
    "result_count": 2,
    "scored_count": 2,
    "task_error_count": 0,
    "scorer_error_count": 0,
    "passed_count": 0,
    "failed_count": 0,
    "errored_count": 0,
    "not_scored_count": 0,
    "scores": [
        {
            "name": "acc",
            "unit": None,
            "direction": "higher_is_better",
            "value_type": "numeric",
            "value": 0.75,
            "observed_count": 2,
        }
    ],
    "metrics": [
        {
            "name": "cost",
            "unit": "$",
            "direction": "lower_is_better",
            "value_type": "numeric",
            "value": 0.0004,
            "observed_count": 2,
        }
    ],
}


def _mock_key_auth():
    return respx.post(f"{BASE_URL}/api/internal/validate-api-key").mock(
        return_value=Response(200, json=KEY_OK_BODY)
    )


def _mock_internal(body, status_code=200):
    return respx.post(INTERNAL_URL).mock(return_value=Response(status_code, json=body))


def _client():
    return TestClient(app, raise_server_exceptions=False)


# ── happy paths ──────────────────────────────────────────────────────────────


@respx.mock
def test_read_run_returns_the_summary_keyed_by_the_resolved_project():
    _mock_key_auth()
    internal = _mock_internal(SUMMARY)
    resp = _client().get("/api/v1/public/evaluation-runs/run1", headers=KEY_HEADER)
    assert resp.status_code == 200
    assert resp.json() == SUMMARY
    # Keyed by the project the key resolved, and nothing else.
    assert json.loads(internal.calls.last.request.content) == {
        "read": "run",
        "projectId": "proj-A",
        "runId": "run1",
    }


@respx.mock
def test_read_run_never_reaches_the_api_key_control_plane_route():
    """The read is served by the internal route; the forwarded API-key route is gone."""
    _mock_key_auth()
    _mock_internal(SUMMARY)
    forwarded = respx.get(url__startswith=f"{BASE_URL}/api/public/").mock(
        return_value=Response(200, json=SUMMARY)
    )
    resp = _client().get("/api/v1/public/evaluation-runs/run1", headers=KEY_HEADER)
    assert resp.status_code == 200
    assert forwarded.call_count == 0


@respx.mock
def test_read_run_uses_the_longer_evaluation_timeout(monkeypatch):
    """A run summary aggregates every result's columns: 30 s, not the catalog 10 s."""
    seen = {}
    real_client = httpx.AsyncClient

    def capture(*args, **kwargs):
        seen.setdefault("timeouts", []).append(kwargs.get("timeout"))
        return real_client(*args, **kwargs)

    _mock_key_auth()
    _mock_internal(SUMMARY)
    monkeypatch.setattr("rest.routers.internal_read_proxy.httpx.AsyncClient", capture)
    resp = _client().get("/api/v1/public/evaluation-runs/run1", headers=KEY_HEADER)
    assert resp.status_code == 200
    assert 30.0 in seen["timeouts"]


# ── auth and parameter gates ─────────────────────────────────────────────────


def test_read_run_requires_authorization():
    resp = _client().get("/api/v1/public/evaluation-runs/run1")
    assert resp.status_code == 401


@respx.mock
def test_read_run_never_passes_a_baseline_on():
    """`baseline` is not part of the contract: a caller that sends one gets the summary."""
    _mock_key_auth()
    internal = _mock_internal(SUMMARY)
    resp = _client().get("/api/v1/public/evaluation-runs/run1?baseline=run0", headers=KEY_HEADER)
    assert resp.status_code == 200
    assert "comparison" not in resp.json()
    assert json.loads(internal.calls.last.request.content) == {
        "read": "run",
        "projectId": "proj-A",
        "runId": "run1",
    }


# ── passthrough statuses (the internal route owns these) ─────────────────────


@respx.mock
def test_read_run_passes_the_internal_routes_refusals_through():
    _mock_key_auth()
    client = _client()
    for status_code, error in (
        (404, "Evaluation run not found"),
        (403, "Data outside retention window"),
    ):
        _mock_internal({"error": error}, status_code=status_code)
        resp = client.get("/api/v1/public/evaluation-runs/run1", headers=KEY_HEADER)
        assert resp.status_code == status_code, error
        assert resp.json()["detail"] == error


@respx.mock
def test_read_run_passthrough_without_a_message_uses_a_generic_detail():
    _mock_key_auth()
    respx.post(INTERNAL_URL).mock(return_value=Response(404, text="<html>nope</html>"))
    resp = _client().get("/api/v1/public/evaluation-runs/run1", headers=KEY_HEADER)
    assert resp.status_code == 404
    assert resp.json()["detail"] == "Not found"


# ── fail closed ──────────────────────────────────────────────────────────────


@respx.mock
def test_read_run_is_503_when_the_evaluation_service_is_unreachable():
    _mock_key_auth()
    respx.post(INTERNAL_URL).mock(side_effect=httpx.ConnectError("down"))
    resp = _client().get("/api/v1/public/evaluation-runs/run1", headers=KEY_HEADER)
    assert resp.status_code == 503
    assert resp.json()["detail"] == "Evaluation service unavailable"


@respx.mock
def test_read_run_is_503_on_an_unexpected_upstream_status():
    """Including 401: the internal secret is this service's own credential."""
    _mock_key_auth()
    client = _client()
    for status_code in (401, 500, 502):
        _mock_internal({"error": "boom"}, status_code=status_code)
        resp = client.get("/api/v1/public/evaluation-runs/run1", headers=KEY_HEADER)
        assert resp.status_code == 503, status_code
        assert resp.json()["detail"] == "Evaluation service error"


@respx.mock
def test_read_run_is_503_on_a_body_outside_the_contract():
    _mock_key_auth()
    client = _client()
    respx.post(INTERNAL_URL).mock(return_value=Response(200, text="not json"))
    assert client.get("/api/v1/public/evaluation-runs/run1", headers=KEY_HEADER).status_code == 503
    for body in (
        [SUMMARY],
        {"evaluation_run_id": "run1"},
        {**SUMMARY, "status": "exploded"},
        {**SUMMARY, "run_number": "14"},
        {**SUMMARY, "run_number": True},
        {**SUMMARY, "scores": [{"name": "acc", "direction": "sideways"}]},
    ):
        _mock_internal(body)
        resp = client.get("/api/v1/public/evaluation-runs/run1", headers=KEY_HEADER)
        assert resp.status_code == 503, body
        assert resp.json()["detail"] == "Evaluation service error"
