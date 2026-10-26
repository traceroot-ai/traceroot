"""Integration tests for the public evaluation listing reads.

These exercise the REAL API-key dependency and the two typed listing routes end to end,
mocking the Next.js side with ``respx``. Like the dataset reads, each is keyed by the
project the credential resolved and delegated to the secret-authed
``project-evaluations`` internal route — never forwarded with the caller's key. Bounds are
rejected at the gateway before any read, and anything ambiguous fails closed as a 503.
"""

import httpx
import pytest
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

EVALUATION = {
    "evaluation_id": "eval_1",
    "name": "Billing routing",
    "evaluation_key": "billing-routing",
    "dataset_id": "refunds",
    "run_count": 3,
    "latest_run": {
        "evaluation_run_id": "run_3",
        "run_number": 3,
        "status": "completed",
        "started_at": "2026-09-14T00:00:00.000Z",
    },
    "created_at": "2026-09-01T00:00:00.000Z",
    "updated_at": "2026-09-14T00:00:00.000Z",
}
EVALUATIONS_BODY = {
    # One field the contract doesn't have, to prove the typed boundary drops it.
    "evaluations": [{**EVALUATION, "row_version": 7}],
    "next_cursor": "eval_0",
}
RUN = {
    "evaluation_run_id": "run_3",
    "evaluation_id": "eval_1",
    "evaluation_name": "Billing routing",
    "evaluation_key": "billing-routing",
    "run_number": 3,
    "candidate_version": "sonnet",
    "environment": "evaluation",
    "status": "completed",
    "dataset_id": "refunds",
    "dataset_version_id": "dv_3",
    "started_at": "2026-09-14T00:00:00.000Z",
    "completed_at": "2026-09-14T00:02:00.000Z",
}
RUNS_BODY = {"runs": [RUN], "next_cursor": None}

READS = [
    ("/api/v1/public/evaluations", EVALUATIONS_BODY),
    ("/api/v1/public/evaluation-runs", RUNS_BODY),
]


def _mock_key_auth():
    return respx.post(f"{BASE_URL}/api/internal/validate-api-key").mock(
        return_value=Response(200, json=KEY_OK_BODY)
    )


def _mock_internal(body, status_code=200):
    return respx.post(INTERNAL_URL).mock(return_value=Response(status_code, json=body))


def _client():
    return TestClient(app, raise_server_exceptions=False)


def _sent(route) -> dict:
    import json

    return json.loads(route.calls.last.request.content)


# ── payloads: keyed by the resolved project, defaults sent explicitly ────────


@respx.mock
def test_list_evaluations_sends_the_default_page_and_drops_fields_outside_the_contract():
    _mock_key_auth()
    internal = _mock_internal(EVALUATIONS_BODY)
    resp = _client().get("/api/v1/public/evaluations", headers=KEY_HEADER)
    assert resp.status_code == 200
    assert resp.json() == {"evaluations": [EVALUATION], "next_cursor": "eval_0"}
    assert _sent(internal) == {"read": "evaluations", "projectId": "proj-A", "limit": 50}


@respx.mock
def test_list_evaluations_passes_the_cursor_and_name_filter():
    _mock_key_auth()
    internal = _mock_internal(EVALUATIONS_BODY)
    resp = _client().get(
        "/api/v1/public/evaluations?limit=5&cursor=eval_9&name=billing", headers=KEY_HEADER
    )
    assert resp.status_code == 200
    assert _sent(internal) == {
        "read": "evaluations",
        "projectId": "proj-A",
        "limit": 5,
        "cursor": "eval_9",
        "name": "billing",
    }


@respx.mock
def test_an_evaluation_nothing_has_run_keeps_its_null_latest_run():
    _mock_key_auth()
    _mock_internal(
        {"evaluations": [{**EVALUATION, "run_count": 0, "latest_run": None}], "next_cursor": None}
    )
    resp = _client().get("/api/v1/public/evaluations", headers=KEY_HEADER)
    assert resp.status_code == 200
    assert resp.json()["evaluations"][0]["latest_run"] is None


@respx.mock
def test_list_runs_sends_the_default_page():
    _mock_key_auth()
    internal = _mock_internal(RUNS_BODY)
    resp = _client().get("/api/v1/public/evaluation-runs", headers=KEY_HEADER)
    assert resp.status_code == 200
    assert resp.json() == RUNS_BODY
    assert _sent(internal) == {"read": "evaluation_runs", "projectId": "proj-A", "limit": 50}


@respx.mock
def test_list_runs_passes_the_evaluation_and_status_filters():
    _mock_key_auth()
    internal = _mock_internal(RUNS_BODY)
    resp = _client().get(
        "/api/v1/public/evaluation-runs?evaluation_id=eval_1&status=running&cursor=run_9",
        headers=KEY_HEADER,
    )
    assert resp.status_code == 200
    assert _sent(internal) == {
        "read": "evaluation_runs",
        "projectId": "proj-A",
        "limit": 50,
        "cursor": "run_9",
        "evaluationId": "eval_1",
        "status": "running",
    }


@respx.mock
def test_a_running_run_lists_with_a_null_completed_at():
    _mock_key_auth()
    _mock_internal(
        {"runs": [{**RUN, "status": "running", "completed_at": None}], "next_cursor": None}
    )
    resp = _client().get("/api/v1/public/evaluation-runs", headers=KEY_HEADER)
    assert resp.status_code == 200
    assert resp.json()["runs"][0]["completed_at"] is None


# ── the listing routes never reach the API-key control plane ─────────────────


@respx.mock
@pytest.mark.parametrize(("path", "body"), READS)
def test_listing_reads_never_reach_the_api_key_control_plane_routes(path, body):
    _mock_key_auth()
    internal = _mock_internal(body)
    forwarded = respx.route(host="localhost", port=3000, path__startswith="/api/public")
    assert _client().get(path, headers=KEY_HEADER).status_code == 200
    assert internal.called
    assert not forwarded.called


# ── bounds, passthrough and fail closed ──────────────────────────────────────


@respx.mock
def test_listing_reads_reject_out_of_range_pages_and_unknown_statuses_before_any_read():
    _mock_key_auth()
    internal = _mock_internal(RUNS_BODY)
    client = _client()
    for path in (
        "/api/v1/public/evaluations?limit=201",
        "/api/v1/public/evaluations?limit=0",
        "/api/v1/public/evaluation-runs?limit=201",
        "/api/v1/public/evaluation-runs?cursor=",
        # The status enum is the contract's, so an unmodelled value never reaches the read.
        "/api/v1/public/evaluation-runs?status=finished",
    ):
        assert client.get(path, headers=KEY_HEADER).status_code == 422, path
    assert internal.call_count == 0


@respx.mock
@pytest.mark.parametrize(("path", "body"), READS)
def test_listing_reads_pass_an_invalid_cursor_through_as_400(path, body):
    _mock_key_auth()
    _mock_internal({"error": "Invalid cursor"}, status_code=400)
    resp = _client().get(f"{path}?cursor=not-in-this-set", headers=KEY_HEADER)
    assert resp.status_code == 400
    assert resp.json()["detail"] == "Invalid cursor"


@respx.mock
@pytest.mark.parametrize(("path", "body"), READS)
def test_listing_reads_are_503_when_the_evaluation_service_is_unreachable(path, body):
    _mock_key_auth()
    respx.post(INTERNAL_URL).mock(side_effect=httpx.ConnectError("down"))
    resp = _client().get(path, headers=KEY_HEADER)
    assert resp.status_code == 503
    assert resp.json()["detail"] == "Evaluation service unavailable"


@respx.mock
@pytest.mark.parametrize(("path", "body"), READS)
def test_listing_reads_fail_closed_on_an_unexpected_status_or_an_off_contract_body(path, body):
    _mock_key_auth()
    client = _client()
    for status_code in (401, 500):
        _mock_internal({"error": "boom"}, status_code=status_code)
        assert client.get(path, headers=KEY_HEADER).status_code == 503
    _mock_internal({"unexpected": True})
    resp = client.get(path, headers=KEY_HEADER)
    assert resp.status_code == 503
    assert resp.json()["detail"] == "Evaluation service error"


@respx.mock
def test_a_run_status_outside_the_published_set_fails_closed_rather_than_being_reported():
    """The status is an enum on the wire, so a row carrying anything else is off-contract."""
    _mock_key_auth()
    _mock_internal({"runs": [{**RUN, "status": "finished"}], "next_cursor": None})
    resp = _client().get("/api/v1/public/evaluation-runs", headers=KEY_HEADER)
    assert resp.status_code == 503
    assert resp.json()["detail"] == "Evaluation service error"
