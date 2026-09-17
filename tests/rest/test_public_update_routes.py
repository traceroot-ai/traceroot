"""Integration tests for the public PATCH routes (six resources + alert status).

Same harness as the create tests: the REAL account-scope dependency plus the
write-path liveness dependency, internal routes mocked with ``respx``. The
routes are thin proxies, so the tests pin the outgoing internal body (the
actor envelope, ``transport: "public-api"``, no ``agentSessionId``, ONLY the
fields the caller sent with an explicit null kept as null, camelCase names),
the response translation (``updated``/``changed`` plus the resource detail),
the 422 surface (unknown keys, null on a non-nullable field, values outside
the stable vocabulary), and service-message parity on passthrough errors.
"""

import json
from urllib.parse import quote

import httpx
import pytest
import respx
from fastapi.testclient import TestClient
from httpx import Response

from rest.main import app

BASE_URL = "http://localhost:3000"
INTERNAL = f"{BASE_URL}/api/internal/write"

USER_HEADER = {"Authorization": "Bearer user-session-token"}
KEY_HEADER = {"Authorization": "Bearer tr-some-key"}

# The account-scope validate-user-token 200 body (no project requested).
ACCOUNT_OK_BODY = {"valid": True, "userId": "u1", "email": "u@example.com"}

WORKSPACE_ROW = {"id": "ws-1", "name": "Beta", "role": "ADMIN"}
PROJECT_ROW = {"id": "proj-1", "name": "Checkout", "workspaceId": "ws-1"}
DETECTOR_ROW = {
    "id": "det-1",
    "name": "Latency spikes",
    "projectId": "proj-1",
    "enabled": False,
    "sampleRate": 50,
}
DASHBOARD_ROW = {"id": "dash-1", "name": "Spend", "projectId": "proj-1"}
WIDGET_ROW = {"id": "wid-1", "dashboardId": "dash-1", "title": "Cost", "type": "query"}
ALERT_ROW = {
    "id": "alr-1",
    "name": "P99 latency",
    "view": "SPANS",
    "measure": "latency",
    "aggregation": "p95",
    "window": "10m",
    "thresholdOperator": ">",
    "threshold": 900,
    "status": "ACTIVE",
    "severity": "UNKNOWN",
    "severityChangedAt": None,
    "alertedAt": None,
    "lastEvaluatedAt": None,
    "lastError": None,
    "lastErrorAt": None,
    "lastNotifyStatus": None,
    "lastNotifyError": None,
    "lastNotifyAt": None,
    "createTime": "2026-08-01T00:00:00Z",
    "updateTime": "2026-08-02T00:00:00Z",
    "creator": "Ada",
    "filters": [{"field": "model_name", "op": "=", "value": "gpt-5"}],
    "renotify": {"mode": "EVERY", "intervalMinutes": 60},
    "noDataMode": "ZERO",
}
ALERT_DETAIL = {
    "id": "alr-1",
    "name": "P99 latency",
    "view": "SPANS",
    "measure": "latency",
    "aggregation": "p95",
    "window": "10m",
    "threshold_operator": ">",
    "threshold": 900.0,
    "status": "ACTIVE",
    "severity": "UNKNOWN",
    "severity_changed_at": None,
    "alerted_at": None,
    "last_evaluated_at": None,
    "last_error": None,
    "last_error_at": None,
    "last_notify_status": None,
    "last_notify_error": None,
    "last_notify_at": None,
    "create_time": "2026-08-01T00:00:00Z",
    "update_time": "2026-08-02T00:00:00Z",
    "creator": "Ada",
    "filters": [{"field": "model_name", "key": None, "op": "=", "value": "gpt-5"}],
    "renotify": {"mode": "EVERY", "interval_minutes": 60},
    "no_data_mode": "ZERO",
}

# Canonical query-dialect spec (mirrors WidgetSpecSchema in
# frontend/ui/src/features/dashboards/types.ts).
QUERY_SPEC = {
    "view": "traces",
    "filters": [{"field": "model_name", "op": "=", "value": "model-a"}],
    "metric": {"measure": "count", "agg": "count"},
    "breakdown": None,
    "display": {"type": "number"},
}
FEED_SPEC = {"filters": [{"field": "errors", "op": "gt", "value": 0}], "limit": 10}

ENVELOPE = {"actorUserId": "u1", "transport": "public-api"}
PROJECT_ENVELOPE = {**ENVELOPE, "projectId": "proj-1"}


def _mock_account_auth():
    """Mock the account-scope introspection to a valid live session."""
    return respx.post(f"{BASE_URL}/api/internal/validate-user-token").mock(
        return_value=Response(200, json=ACCOUNT_OK_BODY)
    )


def _mock_patch(url, body, status_code=200):
    """Mock one internal PATCH route."""
    return respx.patch(url).mock(return_value=Response(status_code, json=body))


def _client():
    return TestClient(app, raise_server_exceptions=False)


def _patch(path, body, headers=USER_HEADER):
    return _client().patch(f"/api/v1/public{path}", json=body, headers=headers)


def _sent(route):
    return json.loads(route.calls.last.request.content)


# (public path, minimal valid body, internal PATCH url, success envelope)
_UPDATE_ROUTES = [
    (
        "/workspaces/ws-1",
        {"name": "Beta"},
        f"{INTERNAL}/workspaces/ws-1",
        {"workspace": WORKSPACE_ROW},
    ),
    (
        "/projects/proj-1",
        {"name": "Checkout"},
        f"{INTERNAL}/projects/proj-1",
        {"project": PROJECT_ROW},
    ),
    (
        "/detectors/det-1",
        {"project_id": "proj-1", "enabled": False},
        f"{INTERNAL}/detectors/det-1",
        {"detector": DETECTOR_ROW},
    ),
    (
        "/dashboards/dash-1",
        {"project_id": "proj-1", "name": "Spend"},
        f"{INTERNAL}/dashboards/dash-1",
        {"dashboard": DASHBOARD_ROW},
    ),
    (
        "/widgets/wid-1",
        {"project_id": "proj-1", "title": "Cost"},
        f"{INTERNAL}/widgets/wid-1",
        {"widget": WIDGET_ROW},
    ),
    (
        "/alerts/alr-1",
        {"project_id": "proj-1", "aggregation": "p95"},
        f"{INTERNAL}/alerts/alr-1",
        {"alert": ALERT_ROW},
    ),
    (
        "/alerts/alr-1/status",
        {"project_id": "proj-1", "status": "PAUSED"},
        f"{INTERNAL}/alerts/alr-1/status",
        {"alert": ALERT_ROW},
    ),
]


# ── auth gating (every route) ───────────────────────────────────────────


@respx.mock
@pytest.mark.parametrize(("path", "body", "url", "envelope"), _UPDATE_ROUTES)
def test_update_requires_authorization(path, body, url, envelope):
    """No Authorization header → 401 before any internal call."""
    resp = _client().patch(f"/api/v1/public{path}", json=body)
    assert resp.status_code == 401


@respx.mock
@pytest.mark.parametrize(("path", "body", "url", "envelope"), _UPDATE_ROUTES)
def test_update_rejects_api_key_with_403(path, body, url, envelope):
    """An API key is project-scoped; edits require a user credential and are
    refused before any lookup."""
    write = _mock_patch(url, {"updated": True, "changed": [], **envelope})
    resp = _patch(path, body, headers=KEY_HEADER)
    assert resp.status_code == 403
    assert write.call_count == 0


# ── workspace / project ─────────────────────────────────────────────────


@respx.mock
def test_update_workspace_happy_path():
    """The internal body is the actor envelope plus the sent field; the response
    carries the changed list and the workspace row."""
    _mock_account_auth()
    write = _mock_patch(
        f"{INTERNAL}/workspaces/ws-1",
        {"updated": True, "changed": ["name"], "workspace": WORKSPACE_ROW},
    )

    resp = _patch("/workspaces/ws-1", {"name": "Beta"})

    assert resp.status_code == 200
    assert resp.json() == {
        "updated": True,
        "changed": ["name"],
        "workspace": {"id": "ws-1", "name": "Beta", "role": "ADMIN"},
    }
    # Exact-body equality also pins that agentSessionId is absent.
    assert _sent(write) == {**ENVELOPE, "name": "Beta"}


@respx.mock
def test_update_workspace_empty_body_reaches_the_service_which_owns_the_400():
    """The proxy does not pre-judge an empty patch: the write service answers
    ``No fields to update`` and that string is the public detail."""
    _mock_account_auth()
    write = _mock_patch(
        f"{INTERNAL}/workspaces/ws-1", {"error": "No fields to update"}, status_code=400
    )

    resp = _patch("/workspaces/ws-1", {})

    assert resp.status_code == 400
    assert resp.json() == {"detail": "No fields to update"}
    assert _sent(write) == ENVELOPE


@respx.mock
def test_update_project_forwards_null_ttl_as_null_and_only_sent_fields():
    """An explicit null crosses as null (clear the field); an unsent field stays
    out of the body entirely, so the service can tell the two apart."""
    _mock_account_auth()
    write = _mock_patch(
        f"{INTERNAL}/projects/proj-1",
        {"updated": True, "changed": ["trace_ttl_days"], "project": PROJECT_ROW},
    )

    resp = _patch("/projects/proj-1", {"trace_ttl_days": None})

    assert resp.status_code == 200
    assert resp.json() == {
        "updated": True,
        "changed": ["trace_ttl_days"],
        "project": {"id": "proj-1", "name": "Checkout", "workspace_id": "ws-1"},
    }
    assert _sent(write) == {**ENVELOPE, "traceTtlDays": None}


@respx.mock
def test_update_project_translates_every_field():
    _mock_account_auth()
    write = _mock_patch(
        f"{INTERNAL}/projects/proj-1",
        {"updated": True, "changed": ["name", "trace_ttl_days"], "project": PROJECT_ROW},
    )

    resp = _patch("/projects/proj-1", {"name": "Checkout", "trace_ttl_days": 30})

    assert resp.status_code == 200
    assert _sent(write) == {**ENVELOPE, "name": "Checkout", "traceTtlDays": 30}


@respx.mock
@pytest.mark.parametrize(
    "body",
    [
        {"workspace_id": "ws-2"},  # tenancy is not editable and not in the body
        {"name": None},  # non-nullable
        {"trace_ttl_days": "thirty"},
    ],
)
def test_update_project_rejects_unknown_keys_and_null_on_non_nullable_fields(body):
    _mock_account_auth()
    write = _mock_patch(f"{INTERNAL}/projects/proj-1", {"updated": True, "changed": []})

    resp = _patch("/projects/proj-1", body)

    assert resp.status_code == 422
    assert write.call_count == 0


@respx.mock
def test_update_workspace_rejects_null_name_with_422():
    _mock_account_auth()
    write = _mock_patch(f"{INTERNAL}/workspaces/ws-1", {"updated": True, "changed": []})

    resp = _patch("/workspaces/ws-1", {"name": None})

    assert resp.status_code == 422
    assert write.call_count == 0


# ── detector ────────────────────────────────────────────────────────────


@respx.mock
def test_update_detector_translates_every_field_and_keeps_nulls():
    """Every snake_case field crosses to camelCase; the nullable model/provider
    fields carry an explicit null through as a clear."""
    _mock_account_auth()
    write = _mock_patch(
        f"{INTERNAL}/detectors/det-1",
        {"updated": True, "changed": ["name", "sample_rate"], "detector": DETECTOR_ROW},
    )

    resp = _patch(
        "/detectors/det-1",
        {
            "project_id": "proj-1",
            "name": "Latency spikes",
            "prompt": "Flag slow traces",
            "enabled": False,
            "sample_rate": 50,
            "enable_rca": True,
            "output_schema": [{"name": "reason", "type": "string"}],
            "trigger_conditions": [{"field": "duration_ms", "op": ">", "value": 1000}],
            "detection_source": "byok",
            "detection_model": None,
            "detection_provider": None,
        },
    )

    assert resp.status_code == 200
    assert resp.json() == {
        "updated": True,
        "changed": ["name", "sample_rate"],
        "detector": {
            "id": "det-1",
            "name": "Latency spikes",
            "project_id": "proj-1",
            "enabled": False,
            "sample_rate": 50,
        },
    }
    assert _sent(write) == {
        **PROJECT_ENVELOPE,
        "name": "Latency spikes",
        "prompt": "Flag slow traces",
        "enabled": False,
        "sampleRate": 50,
        "enableRca": True,
        "outputSchema": [{"name": "reason", "type": "string"}],
        "triggerConditions": [{"field": "duration_ms", "op": ">", "value": 1000}],
        "detectionSource": "byok",
        "detectionModel": None,
        "detectionProvider": None,
    }


@respx.mock
def test_update_detector_forwards_only_the_sent_field():
    """A one-field patch sends exactly that field beside the envelope — no
    defaults, no nulls for what the caller left out."""
    _mock_account_auth()
    write = _mock_patch(
        f"{INTERNAL}/detectors/det-1",
        {"updated": True, "changed": ["sample_rate"], "detector": DETECTOR_ROW},
    )

    resp = _patch("/detectors/det-1", {"project_id": "proj-1", "sample_rate": 50})

    assert resp.status_code == 200
    assert _sent(write) == {**PROJECT_ENVELOPE, "sampleRate": 50}


@respx.mock
def test_update_detector_empty_trigger_conditions_travels_as_an_empty_array():
    """An empty array removes the trigger, so it must reach the service as []."""
    _mock_account_auth()
    write = _mock_patch(
        f"{INTERNAL}/detectors/det-1",
        {"updated": True, "changed": ["trigger_conditions"], "detector": DETECTOR_ROW},
    )

    resp = _patch("/detectors/det-1", {"project_id": "proj-1", "trigger_conditions": []})

    assert resp.status_code == 200
    assert _sent(write) == {**PROJECT_ENVELOPE, "triggerConditions": []}


@respx.mock
@pytest.mark.parametrize(
    "body",
    [
        {"template": "failure"},  # immutable: an unknown key, not a silent drop
        {"name": None},
        {"prompt": None},
        {"enabled": None},
        {"sample_rate": None},
        {"output_schema": None},
        {"trigger_conditions": None},
        {"detection_source": "manual"},  # outside the vocabulary
        {"sample_rate": "half"},
    ],
)
def test_update_detector_rejects_bad_shapes_with_422(body):
    _mock_account_auth()
    write = _mock_patch(f"{INTERNAL}/detectors/det-1", {"updated": True, "changed": []})

    resp = _patch("/detectors/det-1", {"project_id": "proj-1", **body})

    assert resp.status_code == 422
    assert write.call_count == 0


@respx.mock
def test_update_detector_requires_project_id():
    """Project tenancy travels in the body and is required."""
    _mock_account_auth()
    write = _mock_patch(f"{INTERNAL}/detectors/det-1", {"updated": True, "changed": []})

    resp = _patch("/detectors/det-1", {"name": "D"})

    assert resp.status_code == 422
    assert write.call_count == 0


@respx.mock
def test_update_detector_percent_encodes_the_path_id():
    """A path id is quoted before it is spliced into the internal URL, so a
    reserved character cannot rewrite the internal request's path or query."""
    _mock_account_auth()
    write = _mock_patch(
        f"{INTERNAL}/detectors/det%3Fx%3D1",
        {"updated": True, "changed": [], "detector": DETECTOR_ROW},
    )

    resp = _client().patch(
        f"/api/v1/public/detectors/{quote('det?x=1', safe='')}",
        json={"project_id": "proj-1", "name": "D"},
        headers=USER_HEADER,
    )

    assert resp.status_code == 200
    assert write.call_count == 1
    assert write.calls.last.request.url.raw_path == b"/api/internal/write/detectors/det%3Fx%3D1"


# ── dashboard ───────────────────────────────────────────────────────────


@respx.mock
def test_update_dashboard_clears_description_with_null():
    _mock_account_auth()
    write = _mock_patch(
        f"{INTERNAL}/dashboards/dash-1",
        {"updated": True, "changed": ["name", "description"], "dashboard": DASHBOARD_ROW},
    )

    resp = _patch(
        "/dashboards/dash-1", {"project_id": "proj-1", "name": "Spend", "description": None}
    )

    assert resp.status_code == 200
    assert resp.json() == {
        "updated": True,
        "changed": ["name", "description"],
        "dashboard": {"id": "dash-1", "name": "Spend", "project_id": "proj-1"},
    }
    assert _sent(write) == {**PROJECT_ENVELOPE, "name": "Spend", "description": None}


@respx.mock
@pytest.mark.parametrize("body", [{"layout": []}, {"name": None}])
def test_update_dashboard_rejects_unknown_keys_and_null_name(body):
    _mock_account_auth()
    write = _mock_patch(f"{INTERNAL}/dashboards/dash-1", {"updated": True, "changed": []})

    resp = _patch("/dashboards/dash-1", {"project_id": "proj-1", **body})

    assert resp.status_code == 422
    assert write.call_count == 0


# ── widget ──────────────────────────────────────────────────────────────


@respx.mock
def test_update_widget_translates_spec_and_display_config():
    _mock_account_auth()
    write = _mock_patch(
        f"{INTERNAL}/widgets/wid-1",
        {"updated": True, "changed": ["title", "spec", "display_config"], "widget": WIDGET_ROW},
    )

    resp = _patch(
        "/widgets/wid-1",
        {
            "project_id": "proj-1",
            "title": "Cost",
            "spec": QUERY_SPEC,
            "display_config": {"chart": "line"},
        },
    )

    assert resp.status_code == 200
    assert resp.json() == {
        "updated": True,
        "changed": ["title", "spec", "display_config"],
        "widget": {"id": "wid-1", "dashboard_id": "dash-1", "title": "Cost", "type": "query"},
    }
    assert _sent(write) == {
        **PROJECT_ENVELOPE,
        "title": "Cost",
        "spec": QUERY_SPEC,
        "displayConfig": {"chart": "line"},
    }


@respx.mock
def test_update_widget_spec_forwards_only_provided_fields():
    """Spec fields the caller left out stay out (the service fills defaults),
    exactly as on create."""
    _mock_account_auth()
    write = _mock_patch(
        f"{INTERNAL}/widgets/wid-1", {"updated": True, "changed": ["spec"], "widget": WIDGET_ROW}
    )
    spec = {
        "view": "spans",
        "metric": {"measure": "duration_ms", "agg": "p95"},
        "display": {"type": "line"},
    }

    resp = _patch("/widgets/wid-1", {"project_id": "proj-1", "spec": spec})

    assert resp.status_code == 200
    assert _sent(write) == {**PROJECT_ENVELOPE, "spec": spec}


@respx.mock
def test_update_widget_accepts_a_trace_feed_spec_without_a_type():
    """There is no ``type`` on update (the stored one is authoritative), so a
    feed-dialect spec is accepted here and dialect-checked by the service."""
    _mock_account_auth()
    write = _mock_patch(
        f"{INTERNAL}/widgets/wid-1", {"updated": True, "changed": ["spec"], "widget": WIDGET_ROW}
    )

    resp = _patch("/widgets/wid-1", {"project_id": "proj-1", "spec": FEED_SPEC})

    assert resp.status_code == 200
    assert _sent(write)["spec"] == FEED_SPEC


@respx.mock
def test_update_widget_resets_display_config_with_null():
    _mock_account_auth()
    write = _mock_patch(
        f"{INTERNAL}/widgets/wid-1",
        {"updated": True, "changed": ["display_config"], "widget": WIDGET_ROW},
    )

    resp = _patch("/widgets/wid-1", {"project_id": "proj-1", "display_config": None})

    assert resp.status_code == 200
    assert _sent(write) == {**PROJECT_ENVELOPE, "displayConfig": None}


@respx.mock
@pytest.mark.parametrize(
    "body",
    [
        {"type": "trace_feed"},  # immutable
        {"dashboard_id": "dash-2"},  # a widget cannot move
        {"title": None},
        {"spec": None},
        {"spec": {"metric": "input_tokens", "chart": "bar"}},  # neither dialect
    ],
)
def test_update_widget_rejects_bad_shapes_with_422(body):
    _mock_account_auth()
    write = _mock_patch(f"{INTERNAL}/widgets/wid-1", {"updated": True, "changed": []})

    resp = _patch("/widgets/wid-1", {"project_id": "proj-1", **body})

    assert resp.status_code == 422
    assert write.call_count == 0


@respx.mock
def test_update_widget_wrong_dialect_for_stored_type_is_the_services_422():
    """The proxy cannot know the stored type; the service's dialect verdict
    passes through with its own message."""
    _mock_account_auth()
    _mock_patch(
        f"{INTERNAL}/widgets/wid-1",
        {"error": "spec does not match widget type 'query': expected the WidgetSpec dialect"},
        status_code=400,
    )

    resp = _patch("/widgets/wid-1", {"project_id": "proj-1", "spec": FEED_SPEC})

    assert resp.status_code == 400
    assert resp.json() == {
        "detail": "spec does not match widget type 'query': expected the WidgetSpec dialect"
    }


# ── alert ───────────────────────────────────────────────────────────────


@respx.mock
def test_update_alert_forwards_only_the_sent_rule_field():
    """An aggregation-only edit sends aggregation alone; the service merges it
    with the stored rule and answers with the full detail."""
    _mock_account_auth()
    write = _mock_patch(
        f"{INTERNAL}/alerts/alr-1",
        {"updated": True, "changed": ["aggregation"], "alert": ALERT_ROW, "stateReset": True},
    )

    resp = _patch("/alerts/alr-1", {"project_id": "proj-1", "aggregation": "p95"})

    assert resp.status_code == 200
    assert resp.json() == {
        "updated": True,
        "changed": ["aggregation"],
        "alert": ALERT_DETAIL,
        "state_reset": True,
        "page_cleared": False,
    }
    assert _sent(write) == {**PROJECT_ENVELOPE, "aggregation": "p95"}


@respx.mock
def test_update_alert_translates_the_full_rule():
    """Every rule field crosses to camelCase: filters without a null key,
    renotify with its camelCase interval, the enums verbatim."""
    _mock_account_auth()
    write = _mock_patch(
        f"{INTERNAL}/alerts/alr-1",
        {"updated": True, "changed": ["threshold"], "alert": ALERT_ROW, "pageCleared": True},
    )

    resp = _patch(
        "/alerts/alr-1",
        {
            "project_id": "proj-1",
            "name": "P99 latency",
            "view": "SPANS",
            "measure": "latency",
            "aggregation": "p95",
            "filters": [
                {"field": "metadata", "key": "tenant", "op": "=", "value": "acme"},
                {"field": "status", "op": "=", "value": 200},
            ],
            "window": "10m",
            "threshold_operator": ">",
            "threshold": 900,
            "renotify": {"mode": "EVERY", "interval_minutes": 60},
            "no_data_mode": "ZERO",
        },
    )

    assert resp.status_code == 200
    assert resp.json()["page_cleared"] is True
    assert _sent(write) == {
        **PROJECT_ENVELOPE,
        "name": "P99 latency",
        "view": "SPANS",
        "measure": "latency",
        "aggregation": "p95",
        "filters": [
            {"field": "metadata", "key": "tenant", "op": "=", "value": "acme"},
            {"field": "status", "op": "=", "value": 200.0},
        ],
        "window": "10m",
        "thresholdOperator": ">",
        "threshold": 900.0,
        "renotify": {"mode": "EVERY", "intervalMinutes": 60},
        "noDataMode": "ZERO",
    }


@respx.mock
def test_update_alert_off_renotify_and_empty_filters_travel_bare():
    _mock_account_auth()
    write = _mock_patch(
        f"{INTERNAL}/alerts/alr-1", {"updated": True, "changed": ["filters"], "alert": ALERT_ROW}
    )

    resp = _patch(
        "/alerts/alr-1", {"project_id": "proj-1", "filters": [], "renotify": {"mode": "OFF"}}
    )

    assert resp.status_code == 200
    assert _sent(write) == {**PROJECT_ENVELOPE, "filters": [], "renotify": {"mode": "OFF"}}


@respx.mock
@pytest.mark.parametrize(
    "body",
    [
        {"view": "TRACES"},
        {"aggregation": "median"},
        {"window": "3m"},
        {"threshold_operator": "~"},
        {"renotify": {"mode": "EVERY"}},
        {"renotify": {"mode": "OFF", "interval_minutes": 5}},
        {"no_data_mode": "SILENT"},
        {"threshold": "high"},
        {"threshold": None},
        {"name": None},
        {"filters": None},
        {"filters": [{"field": "model_name", "op": "in", "value": "gpt-5"}]},
        {"status": "PAUSED"},  # status has its own route
    ],
)
def test_update_alert_rejects_values_outside_the_stable_vocabulary_with_422(body):
    _mock_account_auth()
    write = _mock_patch(f"{INTERNAL}/alerts/alr-1", {"updated": True, "changed": []})

    resp = _patch("/alerts/alr-1", {"project_id": "proj-1", **body})

    assert resp.status_code == 422
    assert write.call_count == 0


@respx.mock
def test_update_alert_forwards_the_merged_validation_400():
    _mock_account_auth()
    _mock_patch(
        f"{INTERNAL}/alerts/alr-1", {"error": "Invalid aggregation for measure"}, status_code=400
    )

    resp = _patch("/alerts/alr-1", {"project_id": "proj-1", "aggregation": "sum"})

    assert resp.status_code == 400
    assert resp.json() == {"detail": "Invalid aggregation for measure"}


# ── alert status ────────────────────────────────────────────────────────


@respx.mock
def test_set_alert_status_happy_path():
    _mock_account_auth()
    write = _mock_patch(
        f"{INTERNAL}/alerts/alr-1/status",
        {"updated": True, "changed": ["status"], "alert": {**ALERT_ROW, "status": "PAUSED"}},
    )

    resp = _patch("/alerts/alr-1/status", {"project_id": "proj-1", "status": "PAUSED"})

    assert resp.status_code == 200
    assert resp.json() == {
        "updated": True,
        "changed": ["status"],
        "alert": {**ALERT_DETAIL, "status": "PAUSED"},
        "state_reset": False,
        "page_cleared": False,
    }
    assert _sent(write) == {**PROJECT_ENVELOPE, "status": "PAUSED"}


@respx.mock
def test_set_alert_status_resume_surfaces_the_cold_start():
    _mock_account_auth()
    _mock_patch(
        f"{INTERNAL}/alerts/alr-1/status",
        {"updated": True, "changed": ["status"], "alert": ALERT_ROW, "stateReset": True},
    )

    resp = _patch("/alerts/alr-1/status", {"project_id": "proj-1", "status": "ACTIVE"})

    assert resp.status_code == 200
    assert resp.json()["state_reset"] is True


@respx.mock
def test_set_alert_status_forwards_the_parked_409():
    _mock_account_auth()
    _mock_patch(
        f"{INTERNAL}/alerts/alr-1/status",
        {"error": "A parked alert cannot be paused; resume it to run it again"},
        status_code=409,
    )

    resp = _patch("/alerts/alr-1/status", {"project_id": "proj-1", "status": "PAUSED"})

    assert resp.status_code == 409
    assert resp.json() == {"detail": "A parked alert cannot be paused; resume it to run it again"}


@respx.mock
@pytest.mark.parametrize(
    "body",
    [
        {"project_id": "proj-1", "status": "PARKED"},  # the evaluator's verdict only
        {"project_id": "proj-1"},
        {"status": "PAUSED"},
        {"project_id": "proj-1", "status": "PAUSED", "name": "x"},
    ],
)
def test_set_alert_status_rejects_bad_shapes_with_422(body):
    _mock_account_auth()
    write = _mock_patch(f"{INTERNAL}/alerts/alr-1/status", {"updated": True, "changed": []})

    resp = _patch("/alerts/alr-1/status", body)

    assert resp.status_code == 422
    assert write.call_count == 0


# ── upstream error passthrough and fail-closed 503s ─────────────────────


@respx.mock
@pytest.mark.parametrize(
    ("status_code", "message"),
    [
        (400, "name must be a non-empty string"),
        (403, "Requires ADMIN role or higher"),
        (404, "Detector not found"),
        (409, "A detector with this name already exists"),
    ],
)
def test_update_forwards_upstream_client_errors_verbatim(status_code, message):
    _mock_account_auth()
    _mock_patch(f"{INTERNAL}/detectors/det-1", {"error": message}, status_code=status_code)

    resp = _patch("/detectors/det-1", {"project_id": "proj-1", "name": "D"})

    assert resp.status_code == status_code
    assert resp.json() == {"detail": message}


@respx.mock
def test_update_passthrough_without_error_string_uses_fallback():
    _mock_account_auth()
    respx.patch(f"{INTERNAL}/detectors/det-1").mock(
        return_value=Response(404, content=b"<html>gateway page</html>")
    )

    resp = _patch("/detectors/det-1", {"project_id": "proj-1", "name": "D"})

    assert resp.status_code == 404
    assert resp.json() == {"detail": "Not found"}


@respx.mock
def test_update_network_error_is_503():
    _mock_account_auth()
    respx.patch(f"{INTERNAL}/workspaces/ws-1").mock(
        side_effect=httpx.ConnectError("Connection refused")
    )

    resp = _patch("/workspaces/ws-1", {"name": "Beta"})

    assert resp.status_code == 503
    assert resp.json() == {"detail": "Write service unavailable"}


@respx.mock
def test_update_unexpected_upstream_status_is_503():
    _mock_account_auth()
    _mock_patch(f"{INTERNAL}/workspaces/ws-1", {"error": "boom"}, status_code=500)

    resp = _patch("/workspaces/ws-1", {"name": "Beta"})

    assert resp.status_code == 503
    assert resp.json() == {"detail": "Write service error"}


@respx.mock
@pytest.mark.parametrize(("path", "body", "url", "envelope"), _UPDATE_ROUTES)
def test_update_malformed_upstream_envelope_is_503(path, body, url, envelope):
    """A 200 body without the resource envelope fails closed on every route."""
    _mock_account_auth()
    _mock_patch(url, {"updated": True, "changed": []})

    resp = _patch(path, body)

    assert resp.status_code == 503
    assert resp.json() == {"detail": "Write service error"}


@respx.mock
@pytest.mark.parametrize(
    "body",
    [
        {"updated": True, "changed": "name", "workspace": WORKSPACE_ROW},  # changed not a list
        {"updated": True, "changed": ["name"], "workspace": {**WORKSPACE_ROW, "role": None}},
        {"updated": 7, "changed": [], "workspace": WORKSPACE_ROW},
    ],
)
def test_update_wrong_typed_envelope_is_503(body):
    _mock_account_auth()
    _mock_patch(f"{INTERNAL}/workspaces/ws-1", body)

    resp = _patch("/workspaces/ws-1", {"name": "Beta"})

    assert resp.status_code == 503


@respx.mock
def test_update_alert_wrong_typed_flags_are_503():
    """``stateReset``/``pageCleared`` must be booleans when present."""
    _mock_account_auth()
    _mock_patch(
        f"{INTERNAL}/alerts/alr-1",
        {"updated": True, "changed": ["threshold"], "alert": ALERT_ROW, "stateReset": "sometimes"},
    )

    resp = _patch("/alerts/alr-1", {"project_id": "proj-1", "threshold": 1})

    assert resp.status_code == 503
