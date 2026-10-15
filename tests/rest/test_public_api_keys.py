"""Unit tests for the public project API-key gateway.

GET/POST /api/v1/public/api-keys and DELETE /api/v1/public/api-keys/{key_id}.
These routes own no storage — they authenticate and forward to the Next.js
control plane — so the tests pin the proxying contract: the caller's credential
reaches upstream, upstream successes pass through untouched, upstream failures
are normalized to ``{"detail": ...}``, and an unreachable control plane is a 503
in the same shape rather than a stack trace.

Managing keys requires an ``admin`` scope, refused here before anything is
forwarded, so the caller in these proxying tests is admin-scoped — an
``ingest`` key never reaches the forward, which is what the scope tests at the
bottom assert.
"""

import httpx
import pytest
import respx
from fastapi.testclient import TestClient

from rest.main import app
from rest.routers.public import deps
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


def make_auth(project_id: str = "proj-A", scope: str = "admin") -> AuthResult:
    return AuthResult(
        project_id=project_id,
        workspace_id="ws-1",
        billing_plan="enterprise",
        ingestion_blocked=False,
        scope=scope,
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


@respx.mock
def test_an_oversized_declared_body_is_refused_before_it_is_forwarded(client):
    """Nothing in front of this process caps a body, so the forwarder has to."""
    route = respx.post(f"{UI_URL}/api/public/api-keys").mock(
        return_value=httpx.Response(201, json=KEY_SUMMARY)
    )

    response = client.post(
        "/api/v1/public/api-keys",
        content=b"{}",
        headers={
            "Authorization": "Bearer tr-caller",
            "Content-Type": "application/json",
            "Content-Length": str(9 * 1024 * 1024),
        },
    )

    assert response.status_code == 413
    assert response.json() == {"detail": "Request body too large"}
    assert not route.called


@respx.mock
def test_a_cookie_is_never_relayed_to_the_control_plane(client):
    """A forwarded cookie would be a second, session-scoped credential upstream."""
    route = respx.get(f"{UI_URL}/api/public/api-keys").mock(
        return_value=httpx.Response(200, json={"keys": []})
    )

    response = client.get(
        "/api/v1/public/api-keys",
        headers={"Authorization": "Bearer tr-caller", "Cookie": "session=abc"},
    )

    assert response.status_code == 200
    forwarded = {k.lower() for k in route.calls.last.request.headers}
    assert "cookie" not in forwarded
    assert route.calls.last.request.headers["authorization"] == "Bearer tr-caller"


@respx.mock
def test_the_rate_limit_identity_is_stamped_for_the_caller(client, monkeypatch):
    """A mis-keyed bucket raises nothing — it just applies the wrong limit.

    Depending on the unstamped authenticator left the workspace and plan unset, so
    every caller keyed as ``rl:read:free:``: one bucket shared across tenants, at
    the free-tier ceiling for a paying workspace.
    """
    stamped: list[tuple[object, object]] = []
    original = deps.set_rate_limit_identity

    def spy(request, workspace_id, billing_plan):
        stamped.append((workspace_id, billing_plan))
        return original(request, workspace_id, billing_plan)

    monkeypatch.setattr(deps, "set_rate_limit_identity", spy)
    respx.get(f"{UI_URL}/api/public/api-keys").mock(
        return_value=httpx.Response(200, json={"keys": []})
    )

    response = client.get("/api/v1/public/api-keys", headers={"Authorization": "Bearer tr-caller"})

    assert response.status_code == 200
    assert stamped == [("ws-1", "enterprise")]


# ── scope ───────────────────────────────────────────────────────────────
#
# Key management requires an ``admin`` key. The control plane requires the same
# scope and still re-validates, so these assert the local refusal: that an
# under-scoped key is stopped *here*, before a request crosses to the control
# plane, rather than making a network round-trip to be told the same thing.


@pytest.fixture()
def ingest_client():
    """A client whose credential is an ``ingest`` key."""
    app.dependency_overrides[authenticate_api_key] = lambda: make_auth(scope="ingest")
    with TestClient(app, raise_server_exceptions=False) as c:
        yield c
    app.dependency_overrides.clear()


@respx.mock
@pytest.mark.parametrize(
    "method,path",
    [
        ("get", "/api/v1/public/api-keys"),
        ("post", "/api/v1/public/api-keys"),
        ("delete", "/api/v1/public/api-keys/ak_1"),
    ],
)
def test_an_ingest_key_is_refused_before_the_request_is_forwarded(ingest_client, method, path):
    """403 here, and the control plane is never asked.

    ``route.called`` is the assertion that matters: a check placed after the
    forward would still answer 403 — the control plane requires the same scope —
    and this test would still pass on the status alone. It is the untouched
    upstream mock that proves the refusal is local.
    """
    upstream = respx.route(host="localhost", port=3000).mock(
        return_value=httpx.Response(200, json={"keys": []})
    )

    response = getattr(ingest_client, method)(path, headers={"Authorization": "Bearer tr-caller"})

    assert response.status_code == 403
    assert not upstream.called, "an under-scoped key reached the control plane"


@respx.mock
def test_the_refusal_names_the_scope_and_is_the_detail_shape(ingest_client):
    """Same body as the control plane's, so the layer is not identifiable."""
    respx.route(host="localhost", port=3000).mock(return_value=httpx.Response(200, json={}))

    response = ingest_client.get(
        "/api/v1/public/api-keys", headers={"Authorization": "Bearer tr-caller"}
    )

    assert response.json() == {"detail": deps.INSUFFICIENT_SCOPE_DETAIL}


@respx.mock
@pytest.mark.parametrize(
    "method,path",
    [
        ("get", "/api/v1/public/api-keys"),
        ("post", "/api/v1/public/api-keys"),
        ("delete", "/api/v1/public/api-keys/ak_1"),
    ],
)
def test_a_key_carrying_no_scope_is_refused_too(method, path):
    """A credential resolved by a control plane older than the field fails closed.

    Such a key resolves to ``ingest``, so key management is refused rather than
    allowed through on the strength of a field that was never reported.
    """
    app.dependency_overrides[authenticate_api_key] = lambda: make_auth(scope=None)
    upstream = respx.route(host="localhost", port=3000).mock(
        return_value=httpx.Response(200, json={})
    )
    try:
        client = TestClient(app, raise_server_exceptions=False)
        response = getattr(client, method)(path, headers={"Authorization": "Bearer tr-caller"})
    finally:
        app.dependency_overrides.clear()

    assert response.status_code == 403
    assert not upstream.called


@respx.mock
def test_an_admin_key_still_reaches_the_control_plane(client):
    """The gate refuses the under-scoped and changes nothing else.

    The proxying tests above all run on an ``admin`` credential, so this is the
    explicit statement of it: adding the check did not narrow the route for the
    scope that is supposed to use it.
    """
    upstream = respx.get(f"{UI_URL}/api/public/api-keys").mock(
        return_value=httpx.Response(200, json={"keys": [KEY_SUMMARY]})
    )

    response = client.get("/api/v1/public/api-keys", headers={"Authorization": "Bearer tr-caller"})

    assert response.status_code == 200
    assert upstream.called
