"""Tests for the public offline-eval API gateway.

The gateway authenticates the API key and reverse-proxies /api/v1/public/
{datasets,dataset-versions,evaluation-runs}/* to the Next.js /api/public/* control
plane. respx mocks the Next.js upstream; TestClient's ASGI transport is separate,
so only the forward is intercepted.
"""

import json

import pytest
import respx
from fastapi.testclient import TestClient
from httpx import Response

from rest.main import app
from rest.routers.public.deps import AuthResult, authenticate_api_key

UI = "http://localhost:3000"
AUTH_HEADER = {"Authorization": "Bearer tr_key"}


def make_auth() -> AuthResult:
    return AuthResult(
        project_id="proj-A", workspace_id="ws-1", billing_plan="pro", ingestion_blocked=False
    )


@pytest.fixture()
def client():
    app.dependency_overrides[authenticate_api_key] = lambda: make_auth()
    yield TestClient(app)
    app.dependency_overrides.clear()


@respx.mock
def test_forwards_dataset_upsert_with_body_and_bearer(client):
    route = respx.post(f"{UI}/api/public/datasets").mock(
        return_value=Response(201, json={"dataset_id": "ds1", "name": "billing"})
    )
    resp = client.post(
        "/api/v1/public/datasets",
        headers=AUTH_HEADER,
        json={"dataset_id": "ds1", "name": "billing"},
    )
    assert resp.status_code == 201
    assert resp.json()["dataset_id"] == "ds1"
    assert route.called
    sent = route.calls.last.request
    assert json.loads(sent.content)["name"] == "billing"
    # The Bearer is forwarded so Next.js re-authenticates authoritatively.
    assert sent.headers["authorization"] == "Bearer tr_key"


@respx.mock
def test_forwards_nested_subpath_for_version_publish(client):
    route = respx.post(f"{UI}/api/public/datasets/ds1/versions").mock(
        return_value=Response(201, json={"dataset_version_id": "dv2", "version_number": 2})
    )
    resp = client.post(
        "/api/v1/public/datasets/ds1/versions",
        headers=AUTH_HEADER,
        json={
            "base_version_id": None,
            "changes": [{"op": "upsert", "test_case_id": "tc1", "input": "x"}],
        },
    )
    assert resp.status_code == 201
    assert resp.json()["version_number"] == 2
    assert route.called


@respx.mock
def test_forwards_query_params_on_list(client):
    route = respx.get(f"{UI}/api/public/datasets").mock(
        return_value=Response(200, json={"datasets": [], "next_cursor": None})
    )
    resp = client.get("/api/v1/public/datasets?limit=2&name=bill", headers=AUTH_HEADER)
    assert resp.status_code == 200
    assert route.called
    assert dict(route.calls.last.request.url.params) == {"limit": "2", "name": "bill"}


@respx.mock
def test_forwards_deep_run_subpath_for_additive_score(client):
    route = respx.post(f"{UI}/api/public/evaluation-runs/run1/results/tc1/scores").mock(
        return_value=Response(200, json={"score_id": "s1"})
    )
    resp = client.post(
        "/api/v1/public/evaluation-runs/run1/results/tc1/scores",
        headers=AUTH_HEADER,
        json={"scorer_name": "helpfulness", "scorer_version": "v2", "numeric_value": 0.9},
    )
    assert resp.status_code == 200
    assert route.called


@respx.mock
def test_normalizes_error_but_preserves_version_conflict_fields(client):
    # The Next.js control plane fails with its `{error}` envelope; the gateway normalizes
    # the message to the canonical `{detail}` but PRESERVES the version-conflict fields
    # (base_version_id / current_version_id) so the SDK can report the conflict —
    # while still not leaking the raw `error` key or any other upstream field.
    respx.post(f"{UI}/api/public/datasets/ds1/versions").mock(
        return_value=Response(
            409,
            json={
                "error": "conflict",
                "base_version_id": "dv1",
                "current_version_id": "dv9",
                "stack": "secret internals",
            },
        )
    )
    resp = client.post(
        "/api/v1/public/datasets/ds1/versions",
        headers=AUTH_HEADER,
        json={"base_version_id": "dv1", "changes": [{"op": "delete", "test_case_id": "tc1"}]},
    )
    assert resp.status_code == 409
    body = resp.json()
    assert body == {"detail": "conflict", "base_version_id": "dv1", "current_version_id": "dv9"}
    # The raw `error` envelope and any unknown key (e.g. an internal stack) never leak.
    assert "error" not in body
    assert "stack" not in body


@respx.mock
def test_preserves_upstream_detail_error(client):
    # An upstream that already speaks `{detail}` passes its message through unchanged.
    respx.post(f"{UI}/api/public/evaluation-runs").mock(
        return_value=Response(404, json={"detail": "Dataset not found"})
    )
    resp = client.post(
        "/api/v1/public/evaluation-runs",
        headers=AUTH_HEADER,
        json={"evaluation_name": "x", "dataset_id": "missing", "candidate_version": "v1"},
    )
    assert resp.status_code == 404
    assert resp.json() == {"detail": "Dataset not found"}


@respx.mock
def test_non_json_upstream_error_becomes_generic_detail(client):
    # A non-JSON upstream failure (e.g. an HTML 502 page) must not leak; the gateway
    # substitutes a safe generic message while preserving the status.
    respx.post(f"{UI}/api/public/evaluation-runs").mock(
        return_value=Response(502, text="<html><body>Bad Gateway</body></html>")
    )
    resp = client.post(
        "/api/v1/public/evaluation-runs",
        headers=AUTH_HEADER,
        json={"evaluation_name": "x", "dataset_id": "ds1", "candidate_version": "v1"},
    )
    assert resp.status_code == 502
    body = resp.json()
    assert body == {"detail": "Evaluation request failed"}
    assert "<html>" not in json.dumps(body)


@respx.mock
def test_success_response_passes_through_verbatim(client):
    # A 2xx upstream body is forwarded byte-for-byte (no error normalization).
    payload = {"evaluation_run_id": "run1", "run_number": 1, "dataset_version_id": "dv1"}
    respx.post(f"{UI}/api/public/evaluation-runs").mock(return_value=Response(201, json=payload))
    resp = client.post(
        "/api/v1/public/evaluation-runs",
        headers=AUTH_HEADER,
        json={"evaluation_name": "x", "dataset_id": "ds1", "candidate_version": "v1"},
    )
    assert resp.status_code == 201
    assert resp.json() == payload


@respx.mock
def test_returns_503_when_upstream_unreachable(client):
    import httpx

    respx.post(f"{UI}/api/public/datasets").mock(side_effect=httpx.ConnectError("down"))
    resp = client.post(
        "/api/v1/public/datasets", headers=AUTH_HEADER, json={"dataset_id": "ds1", "name": "x"}
    )
    assert resp.status_code == 503


def test_requires_authentication():
    # No auth override here: a missing Authorization header is rejected at the gateway.
    with TestClient(app) as bare:
        resp = bare.post("/api/v1/public/datasets", json={"dataset_id": "ds1", "name": "x"})
    assert resp.status_code == 401


# --- Typed Phase-4 reporting routes -----------------------------------------

VALID_REGISTER = {
    "evaluation_name": "Billing routing",
    "dataset_id": "ds1",
    "candidate_version": "git:abc123",
    "scorers": [{"name": "routing-accuracy", "version": "v3"}],
}
VALID_RESULT = {"test_case_id": "case-1", "input": "q", "status": "passed", "scores": []}
VALID_COMPLETE = {"status": "completed", "case_count": 3, "scored_count": 3}


@respx.mock
def test_register_run_typed_route_forwards_body(client):
    route = respx.post(f"{UI}/api/public/evaluation-runs").mock(
        return_value=Response(201, json={"evaluation_run_id": "run1", "run_number": 1})
    )
    resp = client.post("/api/v1/public/evaluation-runs", headers=AUTH_HEADER, json=VALID_REGISTER)
    assert resp.status_code == 201
    assert route.called
    sent = json.loads(route.calls.last.request.content)
    assert sent["evaluation_name"] == "Billing routing"
    assert route.calls.last.request.headers["authorization"] == "Bearer tr_key"


@respx.mock
def test_upsert_result_typed_route_forwards_to_run_scoped_path(client):
    route = respx.post(f"{UI}/api/public/evaluation-runs/run1/results").mock(
        return_value=Response(200, json={"evaluation_result_id": "res1"})
    )
    resp = client.post(
        "/api/v1/public/evaluation-runs/run1/results", headers=AUTH_HEADER, json=VALID_RESULT
    )
    assert resp.status_code == 200
    assert route.called
    assert json.loads(route.calls.last.request.content)["test_case_id"] == "case-1"


@respx.mock
def test_complete_run_typed_route_forwards_to_run_scoped_path(client):
    route = respx.post(f"{UI}/api/public/evaluation-runs/run1/complete").mock(
        return_value=Response(200, json={"evaluation_run_id": "run1", "status": "completed"})
    )
    resp = client.post(
        "/api/v1/public/evaluation-runs/run1/complete", headers=AUTH_HEADER, json=VALID_COMPLETE
    )
    assert resp.status_code == 200
    assert route.called


@respx.mock
def test_scores_subpath_still_forwards_via_hidden_catchall(client):
    # The additive per-scorer scores endpoint is not typed; it still proxies through
    # the catch-all, unshadowed by the explicit `/results` route above it.
    route = respx.post(f"{UI}/api/public/evaluation-runs/run1/results/case-1/scores").mock(
        return_value=Response(200, json={"score_id": "s1"})
    )
    resp = client.post(
        "/api/v1/public/evaluation-runs/run1/results/case-1/scores",
        headers=AUTH_HEADER,
        json={"scorer_name": "helpfulness", "scorer_version": "v2", "numeric_value": 0.9},
    )
    assert resp.status_code == 200
    assert route.called


@respx.mock
def test_typed_route_rejects_invalid_body_before_forwarding(client):
    # Missing required `candidate_version` → 422 at the gateway; nothing is forwarded.
    route = respx.post(f"{UI}/api/public/evaluation-runs").mock(return_value=Response(201))
    resp = client.post(
        "/api/v1/public/evaluation-runs",
        headers=AUTH_HEADER,
        json={"evaluation_name": "x", "dataset_id": "ds1"},
    )
    assert resp.status_code == 422
    assert not route.called
