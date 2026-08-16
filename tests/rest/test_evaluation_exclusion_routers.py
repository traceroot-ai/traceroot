"""Every trace-derived endpoint must ask the reader to hide evaluation traces.

The service-layer tests (``test_trace_reader_evaluations.py``) prove the SQL is right.
These prove the routers actually REQUEST it: a router that forgets to forward
``include_evaluations`` leaves the flag at the service default today, but the moment
anyone flips a default or adds a positional argument the exclusion silently stops
happening on that surface. Asserting the forwarded keyword pins the wiring.
"""

from unittest.mock import MagicMock

import pytest
from fastapi.testclient import TestClient

from rest.main import app
from rest.routers.deps import ProjectAccessInfo, get_project_access
from rest.routers.public.deps import AuthResult, authenticate_api_key

EMPTY_PAGE = {"data": [], "meta": {"page": 0, "limit": 50, "total": 0}}
SESSION_DETAIL = {
    "session_id": "s1",
    "traces": [],
    "user_ids": [],
    "trace_count": 0,
    "first_trace_time": None,
    "last_trace_time": None,
    "duration_ms": None,
    "total_input_tokens": None,
    "total_output_tokens": None,
    "total_cost": None,
}


@pytest.fixture()
def reader():
    return MagicMock()


@pytest.fixture()
def client(reader):
    """TestClient with project access stubbed and the reader patched into every
    router module under test (each imports the getter by name)."""
    import rest.routers.public.traces_read as public_mod
    import rest.routers.sessions as sessions_mod
    import rest.routers.traces as traces_mod
    import rest.routers.users as users_mod

    async def mock_get_access(project_id: str, x_user_id=None):
        return ProjectAccessInfo(
            project_id=project_id,
            user_id="test-user",
            role="ADMIN",
            workspace_id="ws-test",
            billing_plan="enterprise",
        )

    async def mock_auth():
        return AuthResult(
            project_id="proj-A",
            workspace_id="ws-test",
            billing_plan="enterprise",
            ingestion_blocked=False,
        )

    app.dependency_overrides[get_project_access] = mock_get_access
    app.dependency_overrides[authenticate_api_key] = mock_auth

    modules = (traces_mod, sessions_mod, users_mod, public_mod)
    originals = [m.get_trace_reader_service for m in modules]
    for m in modules:
        m.get_trace_reader_service = lambda: reader

    yield TestClient(app)

    for m, original in zip(modules, originals, strict=True):
        m.get_trace_reader_service = original
    app.dependency_overrides.clear()


# (url, reader attribute, return value) for each surface that lists/aggregates traces.
SURFACES = [
    ("/api/v1/projects/p1/traces", "list_traces", EMPTY_PAGE),
    ("/api/v1/projects/p1/sessions", "list_sessions", EMPTY_PAGE),
    ("/api/v1/projects/p1/sessions/s1", "get_session", SESSION_DETAIL),
    ("/api/v1/projects/p1/users", "list_users", EMPTY_PAGE),
    ("/api/v1/public/traces", "list_traces", EMPTY_PAGE),
]


@pytest.mark.parametrize(("url", "method", "payload"), SURFACES)
def test_endpoint_excludes_evaluations_by_default(client, reader, url, method, payload):
    getattr(reader, method).return_value = payload

    resp = client.get(url)

    assert resp.status_code == 200, resp.text
    assert getattr(reader, method).call_args.kwargs["include_evaluations"] is False


@pytest.mark.parametrize(("url", "method", "payload"), SURFACES)
def test_endpoint_forwards_the_opt_in(client, reader, url, method, payload):
    getattr(reader, method).return_value = payload

    resp = client.get(url, params={"include_evaluations": "true"})

    assert resp.status_code == 200, resp.text
    assert getattr(reader, method).call_args.kwargs["include_evaluations"] is True
