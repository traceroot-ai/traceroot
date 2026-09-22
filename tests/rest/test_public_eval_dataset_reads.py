"""Integration tests for the public evaluation dataset reads.

These exercise the REAL API-key dependency and the four typed dataset read
routes end to end, mocking the Next.js side with ``respx``. Datasets live in
Postgres/Prisma, so each read is delegated to the secret-authed
``project-evaluations`` internal route, keyed by the project the key resolved —
not forwarded to the API-key control-plane routes. A missing dataset or version
passes through as 404; everything ambiguous fails closed as a 503.
"""

import json

import httpx
import pytest
import respx
from fastapi.testclient import TestClient
from httpx import Response

from rest.main import app

BASE_URL = "http://localhost:3000"
INTERNAL_URL = f"{BASE_URL}/api/internal/project-evaluations"

KEY_HEADER = {"Authorization": "Bearer tr-some-key"}
SECRET_HEADER = {"X-Internal-Secret": "test-secret", "x-user-id": "u1"}

KEY_OK_BODY = {
    "valid": True,
    "projectId": "proj-A",
    "workspaceId": "ws-1",
    "billingPlan": "free",
    "ingestionBlocked": False,
}

DATASET = {
    "dataset_id": "refunds",
    "name": "Refunds",
    "description": None,
    "current_dataset_version_id": "dv_3",
    "key": "refunds",
}

LIST_BODY = {
    "datasets": [{**DATASET, "updated_at": "2026-09-14T00:00:00.000Z"}],
    "next_cursor": "row_9",
}

VERSIONS_BODY = {
    "versions": [
        {
            "dataset_version_id": "dv_3",
            "version_number": 3,
            "label": None,
            "note": "added two refund cases",
            "case_count": 42,
            "created_at": "2026-09-14T00:00:00.000Z",
            "is_current": True,
        }
    ],
    "next_cursor": None,
}

VERSION_BODY = {
    "dataset_version_id": "dv_3",
    "dataset_id": "refunds",
    "version_number": 3,
    "label": None,
    "items": [
        {
            "test_case_id": "tc_1",
            "input": {"question": "Can I return this after 40 days?"},
            "expected": {"answer": "No — the window is 30 days."},
            "metadata": {"tag": "policy"},
            "source_trace_id": None,
            "source_span_id": None,
        }
    ],
    "next_cursor": None,
}

READS = [
    ("/api/v1/public/datasets", LIST_BODY),
    ("/api/v1/public/datasets/refunds", DATASET),
    ("/api/v1/public/datasets/refunds/versions", VERSIONS_BODY),
    ("/api/v1/public/dataset-versions/dv_3", VERSION_BODY),
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
    return json.loads(route.calls.last.request.content)


# ── payloads: keyed by the resolved project, defaults sent explicitly ────────


@respx.mock
def test_list_datasets_sends_the_default_page_and_drops_fields_outside_the_contract():
    _mock_key_auth()
    internal = _mock_internal(LIST_BODY)
    resp = _client().get("/api/v1/public/datasets", headers=KEY_HEADER)
    assert resp.status_code == 200
    # The contract never had updated_at; the typed boundary does not publish it.
    assert resp.json() == {"datasets": [DATASET], "next_cursor": "row_9"}
    assert _sent(internal) == {"read": "datasets", "projectId": "proj-A", "limit": 50}


@respx.mock
def test_list_datasets_passes_the_cursor_and_name_filter():
    _mock_key_auth()
    internal = _mock_internal(LIST_BODY)
    resp = _client().get(
        "/api/v1/public/datasets?limit=5&cursor=row_9&name=refund", headers=KEY_HEADER
    )
    assert resp.status_code == 200
    assert _sent(internal) == {
        "read": "datasets",
        "projectId": "proj-A",
        "limit": 5,
        "cursor": "row_9",
        "name": "refund",
    }


@respx.mock
def test_get_dataset_reads_one_dataset_in_the_project():
    _mock_key_auth()
    internal = _mock_internal(DATASET)
    resp = _client().get("/api/v1/public/datasets/refunds", headers=KEY_HEADER)
    assert resp.status_code == 200
    assert resp.json() == DATASET
    assert _sent(internal) == {"read": "dataset", "projectId": "proj-A", "datasetId": "refunds"}


@respx.mock
def test_list_dataset_versions_sends_the_default_page():
    _mock_key_auth()
    internal = _mock_internal(VERSIONS_BODY)
    resp = _client().get("/api/v1/public/datasets/refunds/versions", headers=KEY_HEADER)
    assert resp.status_code == 200
    assert resp.json() == VERSIONS_BODY
    assert _sent(internal) == {
        "read": "dataset_versions",
        "projectId": "proj-A",
        "datasetId": "refunds",
        "limit": 50,
    }


@respx.mock
def test_get_dataset_version_without_a_limit_asks_for_the_whole_version():
    """Released SDKs pull a version with ONE request and never follow a cursor, so a read
    that names no page size must not be given one on their behalf."""
    _mock_key_auth()
    internal = _mock_internal(VERSION_BODY)
    resp = _client().get("/api/v1/public/dataset-versions/dv_3", headers=KEY_HEADER)
    assert resp.status_code == 200
    assert resp.json() == VERSION_BODY
    assert _sent(internal) == {
        "read": "dataset_version",
        "projectId": "proj-A",
        "versionId": "dv_3",
    }


@respx.mock
def test_get_dataset_version_pages_when_asked_and_round_trips_native_json():
    _mock_key_auth()
    internal = _mock_internal(VERSION_BODY)
    resp = _client().get(
        "/api/v1/public/dataset-versions/dv_3?limit=20&cursor=c1", headers=KEY_HEADER
    )
    assert resp.status_code == 200
    assert resp.json() == VERSION_BODY
    assert _sent(internal) == {
        "read": "dataset_version",
        "projectId": "proj-A",
        "versionId": "dv_3",
        "limit": 20,
        "cursor": "c1",
    }


@respx.mock
@pytest.mark.parametrize(("path", "body"), READS)
def test_dataset_reads_never_reach_the_api_key_control_plane_routes(path, body):
    _mock_key_auth()
    _mock_internal(body)
    forwarded = respx.route(url__startswith=f"{BASE_URL}/api/public/").mock(
        return_value=Response(200, json=body)
    )
    resp = _client().get(path, headers=KEY_HEADER)
    assert resp.status_code == 200
    assert forwarded.call_count == 0


# ── passthrough and fail closed ──────────────────────────────────────────────


@respx.mock
@pytest.mark.parametrize(
    ("path", "error"),
    [
        ("/api/v1/public/datasets/gone", "Dataset not found"),
        ("/api/v1/public/datasets/gone/versions", "Dataset not found"),
        ("/api/v1/public/dataset-versions/gone", "Dataset version not found"),
    ],
)
def test_a_missing_dataset_or_version_is_404_with_the_upstream_message(path, error):
    _mock_key_auth()
    _mock_internal({"error": error}, status_code=404)
    resp = _client().get(path, headers=KEY_HEADER)
    assert resp.status_code == 404
    assert resp.json()["detail"] == error


@respx.mock
@pytest.mark.parametrize(("path", "body"), READS)
def test_dataset_reads_are_503_when_the_evaluation_service_is_unreachable(path, body):
    _mock_key_auth()
    respx.post(INTERNAL_URL).mock(side_effect=httpx.ConnectError("down"))
    resp = _client().get(path, headers=KEY_HEADER)
    assert resp.status_code == 503
    assert resp.json()["detail"] == "Evaluation service unavailable"


@respx.mock
@pytest.mark.parametrize(("path", "body"), READS)
def test_dataset_reads_fail_closed_on_an_unexpected_status_or_an_off_contract_body(path, body):
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
def test_dataset_reads_reject_out_of_range_pages_before_any_read():
    _mock_key_auth()
    internal = _mock_internal(LIST_BODY)
    client = _client()
    for path in (
        "/api/v1/public/datasets?limit=201",
        "/api/v1/public/datasets/refunds/versions?limit=0",
        "/api/v1/public/dataset-versions/dv_3?limit=1001",
        "/api/v1/public/datasets?cursor=",
    ):
        assert client.get(path, headers=KEY_HEADER).status_code == 422, path
    assert internal.call_count == 0
