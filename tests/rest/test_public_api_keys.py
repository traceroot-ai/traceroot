"""Unit tests for the public project API-key gateway.

GET/POST /api/v1/public/api-keys and DELETE /api/v1/public/api-keys/{key_id}.
These routes own no storage — they authenticate and forward to the Next.js
control plane — so the tests pin the proxying contract: the caller's credential
reaches upstream, upstream successes pass through untouched, upstream failures
are normalized to ``{"detail": ...}``, and an unreachable control plane is a 503
in the same shape rather than a stack trace.
"""

import httpx
import pytest
import respx
from fastapi.testclient import TestClient

from rest.main import app
from rest.routers.public.deps import AuthResult, authenticate_api_key

UI_URL = "http://localhost:3000"

KEY_SUMMARY = {
    "id": "ak_1",
    "name": "traceroot-setup-demo",
    "hint": "tr-a439-a3dc",
    "project_id": "proj-A",
    "expires_at": None,
    "last_used_at": None,
    "created_at": "2026-07-28T12:00:00.000Z",
}


def make_auth(project_id: str = "proj-A") -> AuthResult:
    return AuthResult(
        project_id=project_id,
        workspace_id="ws-1",
        billing_plan="enterprise",
        ingestion_blocked=False,
    )


@pytest.fixture()
def client():
    app.dependency_overrides[authenticate_api_key] = lambda: make_auth()
    with TestClient(app) as c:
        yield c
    app.dependency_overrides.clear()


@respx.mock
def test_list_forwards_and_passes_the_body_through(client):
    route = respx.get(f"{UI_URL}/api/public/api-keys").mock(
        return_value=httpx.Response(200, json={"keys": [KEY_SUMMARY]})
    )

    response = client.get("/api/v1/public/api-keys", headers={"Authorization": "Bearer tr-caller"})

    assert response.status_code == 200
    assert response.json() == {"keys": [KEY_SUMMARY]}
    assert route.called
    # The control plane owns the key store and re-validates authoritatively, so
    # the caller's credential must arrive intact rather than being exchanged.
    assert route.calls.last.request.headers["authorization"] == "Bearer tr-caller"


@respx.mock
def test_create_preserves_the_201_and_the_one_time_secret(client):
    created = {**KEY_SUMMARY, "key": "tr-brand-new-secret"}
    respx.post(f"{UI_URL}/api/public/api-keys").mock(return_value=httpx.Response(201, json=created))

    response = client.post(
        "/api/v1/public/api-keys",
        json={"name": "traceroot-setup-demo", "expires_in_days": None},
        headers={"Authorization": "Bearer tr-caller"},
    )

    # 201 must survive the proxy: a client distinguishes "created" from "found".
    assert response.status_code == 201
    assert response.json()["key"] == "tr-brand-new-secret"


@respx.mock
def test_revoke_preserves_an_empty_204(client):
    respx.delete(f"{UI_URL}/api/public/api-keys/ak_1").mock(return_value=httpx.Response(204))

    response = client.delete(
        "/api/v1/public/api-keys/ak_1", headers={"Authorization": "Bearer tr-caller"}
    )

    # A 204 has no body; synthesizing one would make a successful revoke look
    # like a malformed response to a strict client.
    assert response.status_code == 204
    assert response.content == b""


@respx.mock
@pytest.mark.parametrize(
    ("upstream_status", "upstream_body", "expected_detail"),
    [
        (
            409,
            {"detail": "An API key named 'x' already exists in this project"},
            "An API key named 'x' already exists in this project",
        ),
        # Older control-plane routes answer {"error": ...}; the public contract
        # is uniformly {"detail": ...}.
        (404, {"error": "API key not found"}, "API key not found"),
    ],
)
def test_upstream_errors_are_normalized_but_keep_their_status(
    client, upstream_status, upstream_body, expected_detail
):
    respx.delete(f"{UI_URL}/api/public/api-keys/ak_1").mock(
        return_value=httpx.Response(upstream_status, json=upstream_body)
    )

    response = client.delete(
        "/api/v1/public/api-keys/ak_1", headers={"Authorization": "Bearer tr-caller"}
    )

    assert response.status_code == upstream_status
    assert response.json() == {"detail": expected_detail}


@respx.mock
def test_an_unparseable_upstream_error_never_leaks_its_body(client):
    # An HTML error page or stack trace must not reach the client verbatim.
    respx.get(f"{UI_URL}/api/public/api-keys").mock(
        return_value=httpx.Response(500, text="<html><body>Traceback: secret/path</body></html>")
    )

    response = client.get("/api/v1/public/api-keys", headers={"Authorization": "Bearer tr-caller"})

    assert response.status_code == 500
    assert response.json() == {"detail": "API key request failed"}
    assert "Traceback" not in response.text


@respx.mock
def test_an_unreachable_control_plane_is_a_503_in_the_same_shape(client):
    respx.get(f"{UI_URL}/api/public/api-keys").mock(side_effect=httpx.ConnectError("refused"))

    response = client.get("/api/v1/public/api-keys", headers={"Authorization": "Bearer tr-caller"})

    assert response.status_code == 503
    assert response.json()["detail"] == "API key service unavailable"


@respx.mock
def test_query_parameters_survive_the_proxy(client):
    route = respx.get(f"{UI_URL}/api/public/api-keys").mock(
        return_value=httpx.Response(200, json={"keys": []})
    )

    client.get("/api/v1/public/api-keys?limit=5", headers={"Authorization": "Bearer tr-caller"})

    assert route.calls.last.request.url.params["limit"] == "5"
