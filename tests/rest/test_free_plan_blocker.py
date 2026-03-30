"""Unit tests for free plan blocker in traces ingestion endpoint.

Tests that free plan users are blocked when ingestion_blocked flag is set.
"""

from unittest.mock import MagicMock

from fastapi.testclient import TestClient

from rest.main import app
from rest.routers.public.traces import AuthResult, authenticate_api_key


def make_auth_result(
    project_id: str = "test-project",
    workspace_id: str = "test-workspace",
    billing_plan: str = "free",
    ingestion_blocked: bool = False,
) -> AuthResult:
    """Create an AuthResult for testing."""
    return AuthResult(
        project_id=project_id,
        workspace_id=workspace_id,
        billing_plan=billing_plan,
        ingestion_blocked=ingestion_blocked,
    )


class TestFreePlanBlocker:
    """Tests for free plan usage blocking."""

    def test_blocked_when_ingestion_blocked_true(self, monkeypatch):
        """User should get 402 when ingestion_blocked is true."""
        monkeypatch.setattr("rest.routers.public.traces.is_billing_enabled", lambda: True)
        app.dependency_overrides[authenticate_api_key] = lambda: make_auth_result(
            billing_plan="free",
            ingestion_blocked=True,
        )

        test_client = TestClient(app)
        response = test_client.post("/api/v1/public/traces", content=b"fake-protobuf")

        assert response.status_code == 402
        assert "Free plan limit exceeded" in response.json()["detail"]

    def test_allowed_when_ingestion_blocked_false(self, monkeypatch):
        """User should be allowed when ingestion_blocked is false."""
        monkeypatch.setattr("rest.routers.public.traces.is_billing_enabled", lambda: True)
        app.dependency_overrides[authenticate_api_key] = lambda: make_auth_result(
            billing_plan="free",
            ingestion_blocked=False,
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
        """Paid plan user should never be blocked."""
        monkeypatch.setattr("rest.routers.public.traces.is_billing_enabled", lambda: True)
        app.dependency_overrides[authenticate_api_key] = lambda: make_auth_result(
            billing_plan="pro",
            ingestion_blocked=False,
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

    def test_starter_plan_not_blocked(self, monkeypatch):
        """Starter plan should not be blocked."""
        monkeypatch.setattr("rest.routers.public.traces.is_billing_enabled", lambda: True)
        app.dependency_overrides[authenticate_api_key] = lambda: make_auth_result(
            billing_plan="starter",
            ingestion_blocked=False,
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
