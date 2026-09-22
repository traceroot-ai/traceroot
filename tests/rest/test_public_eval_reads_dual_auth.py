"""The four dataset reads accept a user login as well as an API key.

These exercise the REAL ``authenticate_public_caller`` dependency through the four dataset
reads, mocking the introspection routes and the internal
``project-evaluations`` route with ``respx``. A user who signed in with the CLI has no
API key, only a session credential and a selected project, so without the dual
credential every CLI read command would fail for them. The reporting writes stay on
the API key: the SDK reports with its ingest credential, never a user login.
"""

import json

import pytest
import respx
from fastapi.testclient import TestClient
from httpx import Response

from rest.main import app

BASE_URL = "http://localhost:3000"
INTERNAL_URL = f"{BASE_URL}/api/internal/project-evaluations"

USER_HEADER = {"Authorization": "Bearer user-session-token"}
KEY_HEADER = {"Authorization": "Bearer tr-some-key"}

# A validate-user-token 200 "member" body: the token resolved to a project the user can read.
USER_OK_BODY = {
    "valid": True,
    "projectId": "proj-A",
    "workspaceId": "ws-1",
    "billingPlan": "free",
    "role": "member",
    "userId": "u1",
}
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
# (path, the read the internal route is asked for, a body inside the contract)
READS = [
    (
        "/api/v1/public/datasets",
        "datasets",
        {"datasets": [{**DATASET, "updated_at": "2026-09-14T00:00:00.000Z"}], "next_cursor": None},
    ),
    ("/api/v1/public/datasets/refunds", "dataset", DATASET),
    (
        "/api/v1/public/datasets/refunds/versions",
        "dataset_versions",
        {"versions": [], "next_cursor": None},
    ),
    (
        "/api/v1/public/dataset-versions/dv_3",
        "dataset_version",
        {
            "dataset_version_id": "dv_3",
            "dataset_id": "refunds",
            "version_number": 3,
            "label": None,
            "items": [],
            "next_cursor": None,
        },
    ),
]
PATHS = [path for path, _, _ in READS]


def _client():
    return TestClient(app, raise_server_exceptions=False)


def _mock_user(status_code=200, body=None):
    return respx.post(f"{BASE_URL}/api/internal/validate-user-token").mock(
        return_value=Response(status_code, json=USER_OK_BODY if body is None else body)
    )


def _mock_key():
    return respx.post(f"{BASE_URL}/api/internal/validate-api-key").mock(
        return_value=Response(200, json=KEY_OK_BODY)
    )


def _with_project(path: str, project_id: str) -> str:
    return f"{path}?project_id={project_id}"


@respx.mock
@pytest.mark.parametrize(("path", "read", "body"), READS)
def test_a_signed_in_user_reads_their_project(path, read, body):
    _mock_user()
    internal = respx.post(INTERNAL_URL).mock(return_value=Response(200, json=body))
    resp = _client().get(_with_project(path, "proj-A"), headers=USER_HEADER)
    assert resp.status_code == 200
    sent = json.loads(internal.calls.last.request.content)
    # Scoped to the project the credential resolved, not to anything else the caller sent.
    assert sent["read"] == read
    assert sent["projectId"] == "proj-A"


@respx.mock
@pytest.mark.parametrize("path", PATHS)
def test_a_user_outside_the_project_is_refused_before_any_read(path):
    _mock_user(status_code=403, body={"valid": False, "hasAccess": False})
    internal = respx.post(INTERNAL_URL).mock(return_value=Response(200, json={}))
    resp = _client().get(_with_project(path, "proj-B"), headers=USER_HEADER)
    # The same answer every dual-credential read gives: the project, not the resource,
    # is refused, so nothing about a run or dataset in it is disclosed.
    assert resp.status_code == 403
    assert internal.call_count == 0


@pytest.mark.parametrize("path", PATHS)
def test_a_user_without_a_project_is_told_to_pick_one(path):
    resp = _client().get(path, headers=USER_HEADER)
    assert resp.status_code == 400
    assert "list_projects" in resp.json()["detail"]


@respx.mock
@pytest.mark.parametrize(
    ("path", "error"),
    [
        ("/api/v1/public/datasets/theirs", "Dataset not found"),
        ("/api/v1/public/dataset-versions/theirs", "Dataset version not found"),
    ],
)
def test_another_projects_resource_is_a_plain_404_for_a_user(path, error):
    _mock_user()
    respx.post(INTERNAL_URL).mock(return_value=Response(404, json={"error": error}))
    resp = _client().get(_with_project(path, "proj-A"), headers=USER_HEADER)
    # Identical to an id that never existed: a member of proj-A learns nothing about proj-B.
    assert resp.status_code == 404
    assert resp.json()["detail"] == error


@respx.mock
@pytest.mark.parametrize(("path", "read", "body"), READS)
def test_an_api_key_still_reads_without_a_project_id(path, read, body):
    _mock_key()
    internal = respx.post(INTERNAL_URL).mock(return_value=Response(200, json=body))
    resp = _client().get(path, headers=KEY_HEADER)
    assert resp.status_code == 200
    assert json.loads(internal.calls.last.request.content)["projectId"] == "proj-A"


@respx.mock
@pytest.mark.parametrize("path", PATHS)
def test_an_api_key_cannot_be_pointed_at_another_project(path):
    _mock_key()
    internal = respx.post(INTERNAL_URL).mock(return_value=Response(200, json={}))
    resp = _client().get(_with_project(path, "proj-B"), headers=KEY_HEADER)
    assert resp.status_code == 400
    assert internal.call_count == 0


@respx.mock
@pytest.mark.parametrize(
    "path",
    [
        "/api/v1/public/evaluation-runs",
        "/api/v1/public/evaluation-runs/run1/results",
        "/api/v1/public/evaluation-runs/run1/complete",
    ],
)
def test_reporting_writes_still_require_an_api_key(path):
    key_check = respx.post(f"{BASE_URL}/api/internal/validate-api-key").mock(
        return_value=Response(401, json={"valid": False})
    )
    user_check = _mock_user()
    resp = _client().post(_with_project(path, "proj-A"), headers=USER_HEADER, json={})
    # A user login is judged as an API key here, and fails as one. It is never
    # introspected as a user, so a signed-in session cannot report results.
    assert resp.status_code == 401
    assert key_check.call_count == 1
    assert user_check.call_count == 0
