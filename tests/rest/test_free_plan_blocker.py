"""Unit tests for free plan blocker in traces ingestion endpoint.

Tests that free plan users are blocked when they exceed the usage limit.
"""

from unittest.mock import MagicMock

from fastapi.testclient import TestClient

from rest.main import app
from rest.routers.public.traces import AuthResult, authenticate_api_key


def make_auth_result(
    project_id: str = "test-project",
    workspace_id: str = "test-workspace",
    workspace_project_ids: list[str] | None = None,
    billing_plan: str = "free",
    free_plan_limit: int | None = 10_000,
) -> AuthResult:
    """Create an AuthResult for testing."""
    return AuthResult(
        project_id=project_id,
        workspace_id=workspace_id,
        workspace_project_ids=workspace_project_ids or [project_id],
        billing_plan=billing_plan,
        free_plan_limit=free_plan_limit,
    )


class TestFreePlanBlocker:
    """Tests for free plan usage blocking."""

    def test_free_plan_blocked_when_over_limit(self, monkeypatch):
        """Free plan user should get 402 when usage exceeds limit."""
        # Mock auth to return free plan with 10k limit
        app.dependency_overrides[authenticate_api_key] = lambda: make_auth_result(
            billing_plan="free",
            free_plan_limit=10_000,
        )

        # Mock ClickHouse to return usage over limit
        monkeypatch.setattr(
            "rest.routers.public.traces.get_current_usage",
            lambda project_id: 10_001,
        )

        test_client = TestClient(app)
        response = test_client.post("/api/v1/public/traces", content=b"fake-protobuf")

        assert response.status_code == 402
        assert "Free plan limit exceeded" in response.json()["detail"]
        assert "10001/10000" in response.json()["detail"]

    def test_free_plan_blocked_at_exact_limit(self, monkeypatch):
        """Free plan user should get 402 when usage equals limit."""
        app.dependency_overrides[authenticate_api_key] = lambda: make_auth_result(
            billing_plan="free",
            free_plan_limit=10_000,
        )

        monkeypatch.setattr(
            "rest.routers.public.traces.get_current_usage",
            lambda project_id: 10_000,
        )

        test_client = TestClient(app)
        response = test_client.post("/api/v1/public/traces", content=b"fake-protobuf")

        assert response.status_code == 402

    def test_free_plan_allowed_under_limit(self, monkeypatch):
        """Free plan user should be allowed when usage is under limit."""
        app.dependency_overrides[authenticate_api_key] = lambda: make_auth_result(
            billing_plan="free",
            free_plan_limit=10_000,
        )

        # Mock usage under limit
        monkeypatch.setattr(
            "rest.routers.public.traces.get_current_usage",
            lambda project_id: 9_999,
        )

        # Mock other dependencies
        monkeypatch.setattr(
            "rest.routers.public.traces.decode_otlp_protobuf",
            lambda body: {"resourceSpans": []},
        )
        mock_s3 = MagicMock()
        monkeypatch.setattr("rest.routers.public.traces.get_s3_service", lambda: mock_s3)
        monkeypatch.setattr("rest.routers.public.traces.process_s3_traces", MagicMock())

        test_client = TestClient(app)
        response = test_client.post("/api/v1/public/traces", content=b"fake-protobuf")

        assert response.status_code == 200

    def test_paid_plan_not_blocked(self, monkeypatch):
        """Paid plan user should never be blocked (no free_plan_limit)."""
        app.dependency_overrides[authenticate_api_key] = lambda: make_auth_result(
            billing_plan="pro",
            free_plan_limit=None,  # Paid plans have no limit
        )

        # Mock other dependencies
        monkeypatch.setattr(
            "rest.routers.public.traces.decode_otlp_protobuf",
            lambda body: {"resourceSpans": []},
        )
        mock_s3 = MagicMock()
        monkeypatch.setattr("rest.routers.public.traces.get_s3_service", lambda: mock_s3)
        monkeypatch.setattr("rest.routers.public.traces.process_s3_traces", MagicMock())

        # Note: get_current_usage should NOT be called for paid plans
        mock_usage = MagicMock()
        monkeypatch.setattr("rest.routers.public.traces.get_current_usage", mock_usage)

        test_client = TestClient(app)
        response = test_client.post("/api/v1/public/traces", content=b"fake-protobuf")

        assert response.status_code == 200
        mock_usage.assert_not_called()

    def test_starter_plan_not_blocked(self, monkeypatch):
        """Starter plan should not be blocked."""
        app.dependency_overrides[authenticate_api_key] = lambda: make_auth_result(
            billing_plan="starter",
            free_plan_limit=None,
        )

        monkeypatch.setattr(
            "rest.routers.public.traces.decode_otlp_protobuf",
            lambda body: {"resourceSpans": []},
        )
        mock_s3 = MagicMock()
        monkeypatch.setattr("rest.routers.public.traces.get_s3_service", lambda: mock_s3)
        monkeypatch.setattr("rest.routers.public.traces.process_s3_traces", MagicMock())

        test_client = TestClient(app)
        response = test_client.post("/api/v1/public/traces", content=b"fake-protobuf")

        assert response.status_code == 200
