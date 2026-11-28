"""The control plane consumes the existing workspace write budget before work."""

from unittest.mock import AsyncMock

import pytest
from fastapi.responses import JSONResponse
from fastapi.testclient import TestClient
from limits.storage import MemoryStorage
from limits.strategies import FixedWindowRateLimiter

from rest import rate_limit
from rest.main import app
from rest.routers.public.deps import AuthResult, authenticate_api_key
from shared.config import _PLAN_LIMITS_WRITE, settings

PATH = "/api/v1/internal/rate-limit"
SECRET_HEADERS = {"X-Internal-Secret": "rate-limit-test-secret"}


@pytest.fixture()
def client(monkeypatch):
    """Exercise the actual decorated route with isolated in-memory counters."""
    storage = MemoryStorage()
    monkeypatch.setattr(rate_limit.limiter, "enabled", True)
    monkeypatch.setattr(rate_limit.limiter, "_storage", storage)
    monkeypatch.setattr(rate_limit.limiter, "_limiter", FixedWindowRateLimiter(storage))
    monkeypatch.setattr(rate_limit.limiter, "_storage_dead", False)
    monkeypatch.setattr(settings, "internal_api_secret", SECRET_HEADERS["X-Internal-Secret"])
    monkeypatch.setitem(_PLAN_LIMITS_WRITE, "free", "2/minute")
    monkeypatch.setitem(_PLAN_LIMITS_WRITE, "pro", "3/minute")
    with TestClient(app) as test_client:
        yield test_client


def consume(client, workspace="ws-1", plan="free"):
    return client.post(
        PATH, headers=SECRET_HEADERS, json={"workspaceId": workspace, "billingPlan": plan}
    )


def test_consumes_write_budget_and_returns_quota_headers(client):
    responses = [consume(client) for _ in range(3)]

    assert [response.status_code for response in responses] == [204, 204, 429]
    assert responses[0].content == b""
    assert responses[0].headers["x-ratelimit-limit"] == "2"
    assert responses[0].headers["x-ratelimit-remaining"] == "1"
    assert responses[1].headers["x-ratelimit-remaining"] == "0"
    throttled = responses[2]
    assert throttled.json()["error"] == "too_many_requests"
    assert throttled.headers["x-ratelimit-remaining"] == "0"
    assert int(throttled.headers["retry-after"]) >= 1


def test_workspace_budgets_are_independent(client):
    assert [consume(client).status_code for _ in range(3)] == [204, 204, 429]
    assert [consume(client, "ws-2").status_code for _ in range(3)] == [204, 204, 429]


def test_uses_the_existing_plan_tiers(client):
    assert [consume(client, "pro-ws", "PRO").status_code for _ in range(4)] == [
        204,
        204,
        204,
        429,
    ]
    assert [consume(client, "free-ws", "unknown").status_code for _ in range(3)] == [
        204,
        204,
        429,
    ]


def test_shares_the_public_api_write_bucket(client, monkeypatch):
    from rest.routers.public import api_keys

    app.dependency_overrides[authenticate_api_key] = lambda: AuthResult(
        project_id="project-1",
        workspace_id="ws-1",
        billing_plan="free",
        ingestion_blocked=False,
        scope="admin",
    )
    forward = AsyncMock(return_value=JSONResponse({"created": True}, status_code=201))
    monkeypatch.setattr(api_keys, "forward", forward)

    assert consume(client).status_code == 204
    response = client.post(
        "/api/v1/public/api-keys", headers={"Authorization": "Bearer project-key"}, json={}
    )
    assert response.status_code == 201
    assert response.headers["x-ratelimit-remaining"] == "0"
    assert consume(client).status_code == 429
    response = client.post(
        "/api/v1/public/api-keys", headers={"Authorization": "Bearer another-key"}, json={}
    )
    assert response.status_code == 429
    forward.assert_awaited_once()


@pytest.mark.parametrize("headers", [{}, {"X-Internal-Secret": "forged"}])
def test_requires_the_internal_secret_without_consuming_budget(client, headers):
    response = client.post(PATH, headers=headers, json={"workspaceId": "ws-1"})
    assert response.status_code == 403
    assert [consume(client).status_code for _ in range(3)] == [204, 204, 429]


@pytest.mark.parametrize("body", [{}, {"workspaceId": ""}, {"workspaceId": None}])
def test_requires_a_workspace_without_consuming_budget(client, body):
    response = client.post(PATH, headers=SECRET_HEADERS, json=body)
    assert response.status_code == 422
    assert [consume(client).status_code for _ in range(3)] == [204, 204, 429]


def test_disabled_limiter_preserves_self_host_behavior(client, monkeypatch):
    monkeypatch.setattr(rate_limit.limiter, "enabled", False)
    responses = [consume(client) for _ in range(4)]
    assert [response.status_code for response in responses] == [204] * 4
    assert all("x-ratelimit-limit" not in response.headers for response in responses)
