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
def test_passes_through_upstream_conflict_status(client):
    respx.post(f"{UI}/api/public/datasets/ds1/versions").mock(
        return_value=Response(409, json={"error": "conflict", "current_version_id": "dv9"})
    )
    resp = client.post(
        "/api/v1/public/datasets/ds1/versions",
        headers=AUTH_HEADER,
        json={"base_version_id": "dv1", "changes": [{"op": "delete", "test_case_id": "tc1"}]},
    )
    assert resp.status_code == 409
    assert resp.json()["error"] == "conflict"


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
