"""Integration tests for the public alert reads.

These exercise the REAL dual-credential dependency (``authenticate_public_caller``)
and the alert read routes end-to-end, mocking the internal Next.js route with
``respx``. Alert rules live in Postgres/Prisma, so the listing and detail reads
are delegated to the secret-authed ``project-alerts`` internal route, keyed by
the project the credential resolved. Client errors the internal route owns
(400/403/404) pass through; everything ambiguous fails closed as a 503.
"""

import json

import httpx
import respx
from fastapi.testclient import TestClient
from httpx import Response

from rest.main import app

BASE_URL = "http://localhost:3000"
INTERNAL_URL = f"{BASE_URL}/api/internal/project-alerts"

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

KEY_OK_BODY = {
    "valid": True,
    "projectId": "proj-A",
    "workspaceId": "ws-1",
    "billingPlan": "enterprise",
    "ingestionBlocked": False,
}

SUMMARY_UPSTREAM = {
    "id": "alr-1",
    "name": "p95 latency over 2s",
    "view": "SPANS",
    "measure": "latency",
    "aggregation": "p95",
    "window": "10m",
    "thresholdOperator": ">",
    "threshold": 2000,
    "status": "ACTIVE",
    "severity": "OK",
    "severityChangedAt": None,
    "alertedAt": None,
    "lastEvaluatedAt": "2026-09-11T20:10:00Z",
    "lastError": None,
    "lastErrorAt": None,
    "lastNotifyStatus": None,
    "lastNotifyError": None,
    "lastNotifyAt": None,
    "createTime": "2026-08-01T00:00:00Z",
    "updateTime": "2026-08-02T00:00:00Z",
    "creator": "Ada Lovelace",
}

SUMMARY_EXPECTED = {
    "id": "alr-1",
    "name": "p95 latency over 2s",
    "view": "SPANS",
    "measure": "latency",
    "aggregation": "p95",
    "window": "10m",
    "threshold_operator": ">",
    "threshold": 2000.0,
    "status": "ACTIVE",
    "severity": "OK",
    "severity_changed_at": None,
    "alerted_at": None,
    "last_evaluated_at": "2026-09-11T20:10:00Z",
    "last_error": None,
    "last_error_at": None,
    "last_notify_status": None,
    "last_notify_error": None,
    "last_notify_at": None,
    "create_time": "2026-08-01T00:00:00Z",
    "update_time": "2026-08-02T00:00:00Z",
    "creator": "Ada Lovelace",
}

LIST_BODY = {
    "alerts": [
        SUMMARY_UPSTREAM,
        {
            **SUMMARY_UPSTREAM,
            "id": "alr-2",
            "name": "Error count",
            "threshold": 0.5,
            "severity": "ALERT",
            "creator": None,
        },
    ],
    "meta": {"page": 0, "limit": 50, "total": 2, "capacity": {"used": 2, "max": 100}},
}

LIST_EXPECTED = {
    "data": [
        SUMMARY_EXPECTED,
        {
            **SUMMARY_EXPECTED,
            "id": "alr-2",
            "name": "Error count",
            "threshold": 0.5,
            "severity": "ALERT",
            "creator": None,
        },
    ],
    "meta": {"page": 0, "limit": 50, "total": 2, "capacity": {"used": 2, "max": 100}},
}

DETAIL_BODY = {
    "alert": {
        **SUMMARY_UPSTREAM,
        "filters": [{"field": "model_name", "op": "=", "value": "gpt-5"}],
        "renotify": {"mode": "EVERY", "intervalMinutes": 60},
        "noDataMode": "HOLD",
    }
}

# The public surface renames the stored camelCase rule: a filter item carries
# an explicit null key on an unkeyed field and renotify spells its interval in
# snake_case, the same way the create request takes it.
DETAIL_EXPECTED = {
    **SUMMARY_EXPECTED,
    "filters": [{"field": "model_name", "key": None, "op": "=", "value": "gpt-5"}],
    "renotify": {"mode": "EVERY", "interval_minutes": 60},
    "no_data_mode": "HOLD",
}


def _mock_user_auth():
    return respx.post(f"{BASE_URL}/api/internal/validate-user-token").mock(
        return_value=Response(200, json=USER_OK_BODY)
    )


def _mock_key_auth():
    return respx.post(f"{BASE_URL}/api/internal/validate-api-key").mock(
        return_value=Response(200, json=KEY_OK_BODY)
    )


def _mock_internal(body, status_code=200):
    return respx.post(INTERNAL_URL).mock(return_value=Response(status_code, json=body))


# ── happy paths ──────────────────────────────────────────────────────────────


@respx.mock
def test_list_alerts_returns_project_alerts_with_capacity():
    _mock_user_auth()
    internal = _mock_internal(LIST_BODY)
    resp = TestClient(app).get("/api/v1/public/alerts?project_id=proj-A", headers=USER_HEADER)
    assert resp.status_code == 200
    assert resp.json() == LIST_EXPECTED
    # The internal route is keyed by the resolved project, never the
    # credential; defaults are sent explicitly so the two sides agree.
    assert json.loads(internal.calls.last.request.content) == {
        "projectId": "proj-A",
        "limit": 50,
        "page": 0,
    }


@respx.mock
def test_internal_url_tolerates_a_trailing_slash_on_the_ui_setting(monkeypatch):
    """The shared read proxy strips a trailing slash from the UI base URL so
    the setting cannot produce a double-slash path (exercised directly: the
    auth dependency builds its own URL and is not under test here)."""
    import asyncio

    from rest.routers.internal_read_proxy import post_internal_read
    from shared.config import settings

    monkeypatch.setattr(settings, "traceroot_ui_url", f"{BASE_URL}/")
    internal = _mock_internal(LIST_BODY)
    body = asyncio.run(
        post_internal_read("/api/internal/project-alerts", {"projectId": "proj-A"}, service="Alert")
    )
    assert body == LIST_BODY
    assert str(internal.calls.last.request.url) == INTERNAL_URL


@respx.mock
def test_list_alerts_forwards_paging_and_search():
    _mock_user_auth()
    internal = _mock_internal(LIST_BODY)
    resp = TestClient(app).get(
        "/api/v1/public/alerts?project_id=proj-A&limit=10&page=3&search_query=latency",
        headers=USER_HEADER,
    )
    assert resp.status_code == 200
    assert json.loads(internal.calls.last.request.content) == {
        "projectId": "proj-A",
        "limit": 10,
        "page": 3,
        "searchQuery": "latency",
    }


@respx.mock
def test_get_alert_returns_the_full_rule():
    _mock_user_auth()
    internal = _mock_internal(DETAIL_BODY)
    resp = TestClient(app).get("/api/v1/public/alerts/alr-1?project_id=proj-A", headers=USER_HEADER)
    assert resp.status_code == 200
    assert resp.json() == DETAIL_EXPECTED
    assert json.loads(internal.calls.last.request.content) == {
        "projectId": "proj-A",
        "alertId": "alr-1",
    }


@respx.mock
def test_list_alerts_api_key_reads_with_creator_redacted():
    """Dual-stamp: an API key fixes its own project and reads the same rows,
    but ``creator`` is nulled — a project key is not a user credential, and
    member names/emails must not be readable by whoever holds an ingest key."""
    _mock_key_auth()
    internal = _mock_internal(LIST_BODY)
    resp = TestClient(app).get("/api/v1/public/alerts", headers=KEY_HEADER)
    assert resp.status_code == 200
    expected = {
        "data": [{**item, "creator": None} for item in LIST_EXPECTED["data"]],
        "meta": LIST_EXPECTED["meta"],
    }
    assert resp.json() == expected
    assert json.loads(internal.calls.last.request.content)["projectId"] == "proj-A"


@respx.mock
def test_get_alert_api_key_reads_with_creator_redacted():
    _mock_key_auth()
    _mock_internal(DETAIL_BODY)
    resp = TestClient(app).get("/api/v1/public/alerts/alr-1", headers=KEY_HEADER)
    assert resp.status_code == 200
    assert resp.json() == {**DETAIL_EXPECTED, "creator": None}


@respx.mock
def test_list_alerts_empty_is_empty_data_with_capacity():
    _mock_user_auth()
    _mock_internal(
        {
            "alerts": [],
            "meta": {"page": 0, "limit": 50, "total": 0, "capacity": {"used": 0, "max": 100}},
        }
    )
    resp = TestClient(app).get("/api/v1/public/alerts?project_id=proj-A", headers=USER_HEADER)
    assert resp.status_code == 200
    assert resp.json() == {
        "data": [],
        "meta": {"page": 0, "limit": 50, "total": 0, "capacity": {"used": 0, "max": 100}},
    }


# ── auth and parameter gates ─────────────────────────────────────────────────


def test_list_alerts_requires_authorization():
    client = TestClient(app, raise_server_exceptions=False)
    resp = client.get("/api/v1/public/alerts")
    assert resp.status_code == 401


@respx.mock
def test_list_alerts_user_token_requires_project_id():
    """A user credential without ?project_id is a 400 before any internal call."""
    internal = _mock_internal(LIST_BODY)
    client = TestClient(app, raise_server_exceptions=False)
    resp = client.get("/api/v1/public/alerts", headers=USER_HEADER)
    assert resp.status_code == 400
    assert internal.call_count == 0


@respx.mock
def test_user_token_without_membership_is_403_before_any_internal_call():
    """A valid token for a project the user is not in surfaces the validator's
    403 on both reads, and the alert service is never consulted."""
    respx.post(f"{BASE_URL}/api/internal/validate-user-token").mock(
        return_value=Response(403, json={"valid": False, "hasAccess": False})
    )
    internal = _mock_internal(LIST_BODY)
    client = TestClient(app, raise_server_exceptions=False)
    for path in ("/api/v1/public/alerts", "/api/v1/public/alerts/alr-1"):
        resp = client.get(f"{path}?project_id=proj-A", headers=USER_HEADER)
        assert resp.status_code == 403, path
    assert internal.call_count == 0


@respx.mock
def test_list_alerts_rejects_out_of_range_paging():
    _mock_user_auth()
    internal = _mock_internal(LIST_BODY)
    client = TestClient(app, raise_server_exceptions=False)
    for query in ("limit=0", "limit=201", "page=-1", "page=10001"):
        resp = client.get(f"/api/v1/public/alerts?project_id=proj-A&{query}", headers=USER_HEADER)
        assert resp.status_code == 422, query
    assert internal.call_count == 0


# ── passthrough statuses (the internal route owns these) ─────────────────────


@respx.mock
def test_get_alert_foreign_id_is_404_with_upstream_detail():
    """An alert outside the resolved project simply isn't found (404)."""
    _mock_user_auth()
    _mock_internal({"error": "Alert not found"}, status_code=404)
    client = TestClient(app, raise_server_exceptions=False)
    resp = client.get(
        "/api/v1/public/alerts/other-projects-alert?project_id=proj-A", headers=USER_HEADER
    )
    assert resp.status_code == 404
    assert resp.json()["detail"] == "Alert not found"


@respx.mock
def test_get_alert_passes_through_400_and_403():
    _mock_user_auth()
    client = TestClient(app, raise_server_exceptions=False)
    for status_code, error in ((400, "alertId must be a string"), (403, "Forbidden")):
        _mock_internal({"error": error}, status_code=status_code)
        resp = client.get("/api/v1/public/alerts/alr-1?project_id=proj-A", headers=USER_HEADER)
        assert resp.status_code == status_code
        assert resp.json()["detail"] == error


@respx.mock
def test_passthrough_with_non_json_body_uses_generic_detail():
    _mock_user_auth()
    respx.post(INTERNAL_URL).mock(return_value=Response(404, content=b"gone"))
    client = TestClient(app, raise_server_exceptions=False)
    resp = client.get("/api/v1/public/alerts/alr-1?project_id=proj-A", headers=USER_HEADER)
    assert resp.status_code == 404
    assert resp.json()["detail"] == "Not found"


@respx.mock
def test_passthrough_without_error_string_uses_generic_detail():
    """A passthrough status whose body has no usable error string never leaks
    the raw body — a generic per-status fallback is surfaced instead."""
    _mock_user_auth()
    _mock_internal({"unexpected": "shape"}, status_code=404)
    client = TestClient(app, raise_server_exceptions=False)
    resp = client.get("/api/v1/public/alerts/alr-1?project_id=proj-A", headers=USER_HEADER)
    assert resp.status_code == 404
    assert resp.json()["detail"] == "Not found"


# ── fail-closed ladder (ambiguity is a 503, never an uncaught 500) ───────────


@respx.mock
def test_list_alerts_network_error_is_503():
    _mock_user_auth()
    respx.post(INTERNAL_URL).mock(side_effect=httpx.ConnectError("Connection refused"))
    client = TestClient(app, raise_server_exceptions=False)
    resp = client.get("/api/v1/public/alerts?project_id=proj-A", headers=USER_HEADER)
    assert resp.status_code == 503


@respx.mock
def test_list_alerts_unexpected_status_is_503():
    _mock_user_auth()
    _mock_internal({}, status_code=500)
    client = TestClient(app, raise_server_exceptions=False)
    resp = client.get("/api/v1/public/alerts?project_id=proj-A", headers=USER_HEADER)
    assert resp.status_code == 503


@respx.mock
def test_list_alerts_upstream_401_is_503():
    """An upstream 401 means OUR internal secret was rejected — that's a
    misconfiguration (503), never the caller's credential failing."""
    _mock_user_auth()
    _mock_internal({"error": "Unauthorized"}, status_code=401)
    client = TestClient(app, raise_server_exceptions=False)
    resp = client.get("/api/v1/public/alerts?project_id=proj-A", headers=USER_HEADER)
    assert resp.status_code == 503


@respx.mock
def test_list_alerts_malformed_json_is_503():
    _mock_user_auth()
    respx.post(INTERNAL_URL).mock(return_value=Response(200, content=b"<html>not json</html>"))
    client = TestClient(app, raise_server_exceptions=False)
    resp = client.get("/api/v1/public/alerts?project_id=proj-A", headers=USER_HEADER)
    assert resp.status_code == 503


@respx.mock
def test_list_alerts_non_object_body_is_503():
    _mock_user_auth()
    _mock_internal([])
    client = TestClient(app, raise_server_exceptions=False)
    resp = client.get("/api/v1/public/alerts?project_id=proj-A", headers=USER_HEADER)
    assert resp.status_code == 503


@respx.mock
def test_list_alerts_missing_alerts_or_meta_is_503():
    _mock_user_auth()
    client = TestClient(app, raise_server_exceptions=False)
    for body in ({"unexpected": "shape"}, {"alerts": []}, {"alerts": {}, "meta": {}}):
        _mock_internal(body)
        resp = client.get("/api/v1/public/alerts?project_id=proj-A", headers=USER_HEADER)
        assert resp.status_code == 503, body


@respx.mock
def test_list_alerts_malformed_item_or_meta_is_503_not_500():
    _mock_user_auth()
    client = TestClient(app, raise_server_exceptions=False)
    for body in (
        {"alerts": [{"name": "only a name"}], "meta": LIST_BODY["meta"]},
        {"alerts": [], "meta": {"page": 0, "limit": 50, "total": 0}},  # no capacity
        {"alerts": [], "meta": {**LIST_BODY["meta"], "capacity": {"used": "many"}}},
    ):
        _mock_internal(body)
        resp = client.get("/api/v1/public/alerts?project_id=proj-A", headers=USER_HEADER)
        assert resp.status_code == 503, body


@respx.mock
def test_get_alert_malformed_body_is_503():
    _mock_user_auth()
    client = TestClient(app, raise_server_exceptions=False)
    for body in (
        {"alert": {"id": "alr-1"}},
        {"alert": {**SUMMARY_UPSTREAM, "threshold": "x"}},
        # A stored rule outside the public vocabulary is a malformed upstream
        # record, not something to pass through half-typed.
        {"alert": {**DETAIL_BODY["alert"], "renotify": {"mode": "SOMETIMES"}}},
        # A contradictory renotify — EVERY with no interval, OFF with one — is
        # a rule the scheduler could not honor, so it is refused, not served.
        {"alert": {**DETAIL_BODY["alert"], "renotify": {"mode": "EVERY"}}},
        {"alert": {**DETAIL_BODY["alert"], "renotify": {"mode": "EVERY", "intervalMinutes": 0}}},
        {"alert": {**DETAIL_BODY["alert"], "renotify": {"mode": "OFF", "intervalMinutes": 5}}},
        {"alert": {**DETAIL_BODY["alert"], "filters": [{"field": "name", "op": "in"}]}},
    ):
        _mock_internal(body)
        resp = client.get("/api/v1/public/alerts/alr-1?project_id=proj-A", headers=USER_HEADER)
        assert resp.status_code == 503, body


# ── internal project-scoped mirror (the in-app agent's dispatch path) ────────


@respx.mock
def test_internal_mirror_list_reads_like_the_public_route(monkeypatch):
    """The internal mirror lives under `/api/v1/internal` (which the ingress
    fixed-404s off the load balancer) and shares the public handler body,
    authenticated by the trusted internal secret alone."""
    from shared.config import settings

    monkeypatch.setattr(settings, "internal_api_secret", "test-secret")
    internal = _mock_internal(LIST_BODY)
    resp = TestClient(app).get(
        "/api/v1/internal/projects/proj-A/alerts?search_query=lat&limit=5",
        headers={"X-Internal-Secret": "test-secret"},
    )
    assert resp.status_code == 200
    assert resp.json() == LIST_EXPECTED
    assert json.loads(internal.calls.last.request.content) == {
        "projectId": "proj-A",
        "limit": 5,
        "page": 0,
        "searchQuery": "lat",
    }


@respx.mock
def test_internal_mirror_detail_reads_like_the_public_route(monkeypatch):
    from shared.config import settings

    monkeypatch.setattr(settings, "internal_api_secret", "test-secret")
    _mock_internal(DETAIL_BODY)
    resp = TestClient(app).get(
        "/api/v1/internal/projects/proj-A/alerts/alr-1",
        headers={"X-Internal-Secret": "test-secret"},
    )
    assert resp.status_code == 200
    assert resp.json() == DETAIL_EXPECTED


@respx.mock
def test_internal_mirror_rejects_a_caller_without_the_secret(monkeypatch):
    """An x-user-id header alone buys nothing: the mirror is secret-only."""
    from shared.config import settings

    monkeypatch.setattr(settings, "internal_api_secret", "test-secret")
    internal = _mock_internal(LIST_BODY)
    client = TestClient(app, raise_server_exceptions=False)
    resp = client.get("/api/v1/internal/projects/proj-A/alerts", headers={"x-user-id": "u1"})
    assert resp.status_code == 403
    assert internal.call_count == 0


def test_alert_mirror_is_off_the_public_project_surface():
    """The alert mirror must not be mounted at `/api/v1/projects/...`.

    That prefix is ALB-routed, and its project access check trusts a
    caller-supplied x-user-id — anyone knowing a project id and a member id
    could read the tenant's alert rules (creator identities included) with no
    token at all. Only the internal prefix, which the ingress drops, may serve
    it.
    """
    from fastapi.routing import APIRoute

    paths = {r.path for r in app.routes if isinstance(r, APIRoute)}
    assert "/api/v1/projects/{project_id}/alerts" not in paths
    assert "/api/v1/projects/{project_id}/alerts/{alert_id}" not in paths
    assert "/api/v1/internal/projects/{project_id}/alerts" in paths
