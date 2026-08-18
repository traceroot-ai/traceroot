"""Integration tests for the dual-credential public read auth.

These exercise the REAL ``authenticate_public_caller`` dependency through a
swapped read route (``list_traces``), mocking the internal introspection routes
with ``respx``. They complement the dependency-level tests by proving the user
credential is wired end-to-end through the routes, and that an API key still
behaves identically (same body shape, project scoping, and mismatch guard).

The API-key override-based suites in ``test_public_traces_read.py`` cover the
byte-identical key-auth response contract; here the token value matters because
the real dependency discriminates on the ``tr-`` prefix.
"""

from unittest.mock import MagicMock

import respx
from fastapi.testclient import TestClient
from httpx import Response

from rest.main import app

BASE_URL = "http://localhost:3000"

USER_HEADER = {"Authorization": "Bearer user-session-token"}
KEY_HEADER = {"Authorization": "Bearer tr-some-key"}

# A validate-user-token 200 "member" body: the introspection route resolved the
# token to a project the user can read.
USER_OK_BODY = {
    "valid": True,
    "projectId": "proj-A",
    "workspaceId": "ws-1",
    "billingPlan": "enterprise",
    "role": "member",
    "userId": "u1",
}

EMPTY_LIST = {"data": [], "meta": {"page": 0, "limit": 50, "total": 0}}


def _stub_reader(monkeypatch) -> MagicMock:
    """Replace the trace reader with a mock that returns an empty page.

    Args:
        monkeypatch: pytest monkeypatch fixture (auto-reverts the patch).

    Returns:
        MagicMock: The stubbed reader, for call-arg assertions.
    """
    reader = MagicMock()
    reader.list_traces.return_value = EMPTY_LIST
    import rest.routers.public.traces_read as mod

    monkeypatch.setattr(mod, "get_trace_reader_service", lambda: reader)
    return reader


@respx.mock
def test_user_token_with_project_id_reads_like_key_path(monkeypatch):
    """A user token + ?project_id resolves via validate-user-token and reads the
    same body shape as the key path, scoped to the resolved project."""
    respx.post(f"{BASE_URL}/api/internal/validate-user-token").mock(
        return_value=Response(200, json=USER_OK_BODY)
    )
    reader = _stub_reader(monkeypatch)
    resp = TestClient(app).get("/api/v1/public/traces?project_id=proj-A", headers=USER_HEADER)
    assert resp.status_code == 200
    assert resp.json() == EMPTY_LIST
    # The read is scoped to the project resolved from the token, not a client value.
    assert reader.list_traces.call_args.kwargs["project_id"] == "proj-A"


def test_user_token_without_project_id_is_400_naming_list_projects():
    """A user credential is only meaningful scoped to a project: absent
    project_id is a 400 that points the caller at list_projects."""
    client = TestClient(app, raise_server_exceptions=False)
    resp = client.get("/api/v1/public/traces", headers=USER_HEADER)
    assert resp.status_code == 400
    assert "list_projects" in resp.json()["detail"]


@respx.mock
def test_user_token_without_access_is_403():
    """A valid token with no access to the project surfaces the validator's 403."""
    respx.post(f"{BASE_URL}/api/internal/validate-user-token").mock(
        return_value=Response(403, json={"valid": False, "hasAccess": False})
    )
    client = TestClient(app, raise_server_exceptions=False)
    resp = client.get("/api/v1/public/traces?project_id=proj-A", headers=USER_HEADER)
    assert resp.status_code == 403


@respx.mock
def test_key_with_mismatched_project_id_is_400():
    """A tr- key whose project contradicts an explicit ?project_id is a 400
    (absent-or-equal rule), exercised through the real dependency."""
    respx.post(f"{BASE_URL}/api/internal/validate-api-key").mock(
        return_value=Response(
            200,
            json={
                "valid": True,
                "projectId": "proj-A",
                "workspaceId": "ws-1",
                "billingPlan": "enterprise",
                "ingestionBlocked": False,
            },
        )
    )
    client = TestClient(app, raise_server_exceptions=False)
    resp = client.get("/api/v1/public/traces?project_id=other", headers=KEY_HEADER)
    assert resp.status_code == 400
    assert "does not match" in resp.json()["detail"]


@respx.mock
def test_key_with_matching_project_id_succeeds(monkeypatch):
    """A tr- key with a confirming ?project_id reads normally — the cross-check
    only rejects contradictions, exercised through the real dependency."""
    respx.post(f"{BASE_URL}/api/internal/validate-api-key").mock(
        return_value=Response(
            200,
            json={
                "valid": True,
                "projectId": "proj-A",
                "workspaceId": "ws-1",
                "billingPlan": "enterprise",
                "ingestionBlocked": False,
            },
        )
    )
    reader = _stub_reader(monkeypatch)
    resp = TestClient(app).get("/api/v1/public/traces?project_id=proj-A", headers=KEY_HEADER)
    assert resp.status_code == 200
    assert resp.json() == EMPTY_LIST
    assert reader.list_traces.call_args.kwargs["project_id"] == "proj-A"
