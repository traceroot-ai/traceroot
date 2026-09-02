"""Integration tests for the project-scoped public writes (detector/dashboard/widget).

Same harness as the account-write tests: the REAL account-scope dependency plus
the write-path liveness dependency, internal routes mocked with ``respx``. The
project-scoped creates take their ``project_id`` in the body (the write service
resolves membership from the actor), so they run on the same account-scope
credential as workspace/project creation. The tests pin the camelCase body
translation per resource, absent-optional omission, the ``created`` flag, and
service-message parity.
"""

import json

import httpx
import pytest
import respx
from fastapi.testclient import TestClient
from httpx import Response

from rest.main import app

BASE_URL = "http://localhost:3000"
DETECTOR_WRITE_URL = f"{BASE_URL}/api/internal/write/detectors"
DASHBOARD_WRITE_URL = f"{BASE_URL}/api/internal/write/dashboards"
WIDGET_WRITE_URL = f"{BASE_URL}/api/internal/write/widgets"

USER_HEADER = {"Authorization": "Bearer user-session-token"}
KEY_HEADER = {"Authorization": "Bearer tr-some-key"}

# The account-scope validate-user-token 200 body (no project requested).
ACCOUNT_OK_BODY = {"valid": True, "userId": "u1", "email": "u@example.com"}

DETECTOR_ROW = {
    "id": "det-new",
    "name": "Latency spikes",
    "projectId": "proj-1",
    "enabled": True,
    "sampleRate": 25,
}
DASHBOARD_ROW = {"id": "dash-new", "name": "Spend", "projectId": "proj-1"}
WIDGET_ROW = {"id": "wid-new", "dashboardId": "dash-1", "title": "Cost", "type": "query"}


def _mock_account_auth():
    """Mock the account-scope introspection to a valid live session."""
    return respx.post(f"{BASE_URL}/api/internal/validate-user-token").mock(
        return_value=Response(200, json=ACCOUNT_OK_BODY)
    )


def _mock_write(url, body, status_code=200):
    """Mock one internal write route."""
    return respx.post(url).mock(return_value=Response(status_code, json=body))


def _client():
    return TestClient(app, raise_server_exceptions=False)


# ── detector ────────────────────────────────────────────────────────────


@respx.mock
def test_create_detector_translates_all_optionals():
    """Every snake_case optional crosses to its camelCase internal field."""
    _mock_account_auth()
    write = _mock_write(DETECTOR_WRITE_URL, {"created": True, "detector": DETECTOR_ROW})

    resp = _client().post(
        "/api/v1/public/detectors",
        json={
            "project_id": "proj-1",
            "name": "Latency spikes",
            "template": "custom",
            "prompt": "Flag slow spans",
            "sample_rate": 25,
            "output_schema": [{"name": "severity", "type": "string"}],
            "trigger_conditions": [{"field": "duration_ms", "op": "gt", "value": 1000}],
            "detection_source": "system",
            "detection_model": "model-a",
            "detection_provider": "provider-a",
            "enable_rca": True,
            "enabled": True,
        },
        headers=USER_HEADER,
    )

    assert resp.status_code == 200
    assert resp.json() == {
        "id": "det-new",
        "name": "Latency spikes",
        "project_id": "proj-1",
        "enabled": True,
        "sample_rate": 25,
        "created": True,
    }
    assert json.loads(write.calls.last.request.content) == {
        "actorUserId": "u1",
        "projectId": "proj-1",
        "name": "Latency spikes",
        "template": "custom",
        "prompt": "Flag slow spans",
        "sampleRate": 25,
        "outputSchema": [{"name": "severity", "type": "string"}],
        "triggerConditions": [{"field": "duration_ms", "op": "gt", "value": 1000}],
        "detectionSource": "system",
        "detectionModel": "model-a",
        "detectionProvider": "provider-a",
        "enableRca": True,
        "enabled": True,
        "transport": "public-api",
    }


@respx.mock
def test_create_detector_omits_absent_optionals():
    """Unset optionals are left out of the internal body entirely."""
    _mock_account_auth()
    write = _mock_write(DETECTOR_WRITE_URL, {"created": True, "detector": DETECTOR_ROW})

    resp = _client().post(
        "/api/v1/public/detectors",
        json={
            "project_id": "proj-1",
            "name": "Latency spikes",
            "template": "custom",
            "prompt": "Flag slow spans",
        },
        headers=USER_HEADER,
    )

    assert resp.status_code == 200
    assert json.loads(write.calls.last.request.content) == {
        "actorUserId": "u1",
        "projectId": "proj-1",
        "name": "Latency spikes",
        "template": "custom",
        "prompt": "Flag slow spans",
        "transport": "public-api",
    }


@respx.mock
def test_create_detector_forwards_the_service_role_message():
    """The write service's own 403 string is the public detail, verbatim."""
    _mock_account_auth()
    _mock_write(DETECTOR_WRITE_URL, {"error": "Requires MEMBER role or higher"}, status_code=403)

    resp = _client().post(
        "/api/v1/public/detectors",
        json={"project_id": "proj-1", "name": "D", "template": "custom", "prompt": "p"},
        headers=USER_HEADER,
    )

    assert resp.status_code == 403
    assert resp.json() == {"detail": "Requires MEMBER role or higher"}


@respx.mock
def test_create_detector_network_error_is_503():
    """A network error reaching the internal write route fails closed (503)."""
    _mock_account_auth()
    respx.post(DETECTOR_WRITE_URL).mock(side_effect=httpx.ConnectError("Connection refused"))

    resp = _client().post(
        "/api/v1/public/detectors",
        json={"project_id": "proj-1", "name": "D", "template": "custom", "prompt": "p"},
        headers=USER_HEADER,
    )

    assert resp.status_code == 503


@respx.mock
def test_create_detector_malformed_upstream_body_is_503():
    """A 200 body without the resource envelope is malformed → 503, never a 500."""
    _mock_account_auth()
    _mock_write(DETECTOR_WRITE_URL, {"created": True})

    resp = _client().post(
        "/api/v1/public/detectors",
        json={"project_id": "proj-1", "name": "D", "template": "custom", "prompt": "p"},
        headers=USER_HEADER,
    )

    assert resp.status_code == 503


@respx.mock
def test_create_detector_wrong_typed_envelope_is_503():
    """A 200 envelope whose fields are wrongly typed fails closed, never a 500.

    The response model rejects these, and that rejection must map to the same
    controlled 503 as a missing envelope.
    """
    _mock_account_auth()
    _mock_write(
        DETECTOR_WRITE_URL,
        {"created": True, "detector": {**DETECTOR_ROW, "sampleRate": "twenty-five"}},
    )

    resp = _client().post(
        "/api/v1/public/detectors",
        json={"project_id": "proj-1", "name": "D", "template": "custom", "prompt": "p"},
        headers=USER_HEADER,
    )

    assert resp.status_code == 503


# ── dashboard ───────────────────────────────────────────────────────────


@respx.mock
def test_create_dashboard_idempotent_hit_reports_created_false():
    """The dashboard create surfaces the idempotent created flag and translates
    the description across."""
    _mock_account_auth()
    write = _mock_write(DASHBOARD_WRITE_URL, {"created": False, "dashboard": DASHBOARD_ROW})

    resp = _client().post(
        "/api/v1/public/dashboards",
        json={"project_id": "proj-1", "name": "Spend", "description": "Spend at a glance"},
        headers=USER_HEADER,
    )

    assert resp.status_code == 200
    assert resp.json() == {
        "id": "dash-new",
        "name": "Spend",
        "project_id": "proj-1",
        "created": False,
    }
    assert json.loads(write.calls.last.request.content) == {
        "actorUserId": "u1",
        "projectId": "proj-1",
        "name": "Spend",
        "description": "Spend at a glance",
        "transport": "public-api",
    }


@respx.mock
def test_create_dashboard_omits_absent_description():
    _mock_account_auth()
    write = _mock_write(DASHBOARD_WRITE_URL, {"created": True, "dashboard": DASHBOARD_ROW})

    resp = _client().post(
        "/api/v1/public/dashboards",
        json={"project_id": "proj-1", "name": "Spend"},
        headers=USER_HEADER,
    )

    assert resp.status_code == 200
    assert json.loads(write.calls.last.request.content) == {
        "actorUserId": "u1",
        "projectId": "proj-1",
        "name": "Spend",
        "transport": "public-api",
    }


@respx.mock
def test_create_dashboard_rejects_api_key_with_403():
    """An API key is project-scoped but writes require a user credential."""
    write = _mock_write(DASHBOARD_WRITE_URL, {"created": True, "dashboard": DASHBOARD_ROW})

    resp = _client().post(
        "/api/v1/public/dashboards",
        json={"project_id": "proj-1", "name": "Spend"},
        headers=KEY_HEADER,
    )

    assert resp.status_code == 403
    assert write.call_count == 0


# ── widget ──────────────────────────────────────────────────────────────


@respx.mock
def test_create_widget_translates_display_config():
    """Widget creation is strict (created always true) and translates
    display_config across."""
    _mock_account_auth()
    write = _mock_write(WIDGET_WRITE_URL, {"created": True, "widget": WIDGET_ROW})

    resp = _client().post(
        "/api/v1/public/widgets",
        json={
            "project_id": "proj-1",
            "dashboard_id": "dash-1",
            "title": "Cost",
            "type": "query",
            "spec": {"measure": "cost"},
            "display_config": {"chart": "line"},
        },
        headers=USER_HEADER,
    )

    assert resp.status_code == 200
    assert resp.json() == {
        "id": "wid-new",
        "dashboard_id": "dash-1",
        "title": "Cost",
        "type": "query",
        "created": True,
    }
    assert json.loads(write.calls.last.request.content) == {
        "actorUserId": "u1",
        "projectId": "proj-1",
        "dashboardId": "dash-1",
        "title": "Cost",
        "type": "query",
        "spec": {"measure": "cost"},
        "displayConfig": {"chart": "line"},
        "transport": "public-api",
    }


@respx.mock
def test_create_widget_omits_absent_display_config():
    _mock_account_auth()
    write = _mock_write(WIDGET_WRITE_URL, {"created": True, "widget": WIDGET_ROW})

    resp = _client().post(
        "/api/v1/public/widgets",
        json={
            "project_id": "proj-1",
            "dashboard_id": "dash-1",
            "title": "Cost",
            "type": "query",
            "spec": {"measure": "cost"},
        },
        headers=USER_HEADER,
    )

    assert resp.status_code == 200
    assert json.loads(write.calls.last.request.content) == {
        "actorUserId": "u1",
        "projectId": "proj-1",
        "dashboardId": "dash-1",
        "title": "Cost",
        "type": "query",
        "spec": {"measure": "cost"},
        "transport": "public-api",
    }


def test_create_widget_requires_authorization():
    """No Authorization header → 401 before any internal call."""
    resp = _client().post(
        "/api/v1/public/widgets",
        json={
            "project_id": "proj-1",
            "dashboard_id": "dash-1",
            "title": "Cost",
            "type": "query",
            "spec": {},
        },
    )
    assert resp.status_code == 401


@respx.mock
def test_create_widget_forwards_upstream_400_message():
    """The internal route's shape-check message is the public detail, verbatim."""
    _mock_account_auth()
    _mock_write(WIDGET_WRITE_URL, {"error": "title is required"}, status_code=400)

    resp = _client().post(
        "/api/v1/public/widgets",
        json={
            "project_id": "proj-1",
            "dashboard_id": "dash-1",
            "title": " ",
            "type": "query",
            "spec": {},
        },
        headers=USER_HEADER,
    )

    assert resp.status_code == 400
    assert resp.json() == {"detail": "title is required"}


# ── non-finite floats (NaN / Infinity) ──────────────────────────────────

_JSON_HEADERS = {**USER_HEADER, "Content-Type": "application/json"}

_NON_FINITE_BODIES = [
    (
        "/api/v1/public/widgets",
        '{"project_id": "proj-1", "dashboard_id": "dash-1", "title": "Cost",'
        ' "type": "query", "spec": {"value": NaN}}',
    ),
    (
        "/api/v1/public/widgets",
        '{"project_id": "proj-1", "dashboard_id": "dash-1", "title": "Cost",'
        ' "type": "query", "spec": {}, "display_config": {"a": Infinity}}',
    ),
    (
        "/api/v1/public/detectors",
        '{"project_id": "proj-1", "name": "D", "template": "custom",'
        ' "prompt": "p", "output_schema": [-Infinity]}',
    ),
    (
        "/api/v1/public/detectors",
        '{"project_id": "proj-1", "name": "D", "template": "custom",'
        ' "prompt": "p", "trigger_conditions": [{"value": NaN}]}',
    ),
]


@respx.mock
@pytest.mark.parametrize(("path", "body"), _NON_FINITE_BODIES)
def test_non_finite_floats_are_a_422_not_a_500(path, body):
    """Bare NaN/Infinity tokens in a JSON payload field are a clean 422.

    ``json.loads`` accepts the bare tokens, but the proxy's httpx client
    re-encodes with ``allow_nan=False`` — without schema-level rejection the
    encode raises an uncaught ValueError and the route 500s. The schema layer
    must turn these into a validation error instead.
    """
    _mock_account_auth()
    _mock_write(DETECTOR_WRITE_URL, {"created": True, "detector": DETECTOR_ROW})
    _mock_write(WIDGET_WRITE_URL, {"created": True, "widget": WIDGET_ROW})

    resp = _client().post(path, content=body, headers=_JSON_HEADERS)

    assert resp.status_code == 422
