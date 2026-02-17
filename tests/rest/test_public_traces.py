"""Unit tests for public traces ingestion endpoint.

Uses FastAPI TestClient with mocked S3, Celery, and protobuf decode.
"""

import gzip
from unittest.mock import MagicMock

import pytest
from fastapi.testclient import TestClient

from rest.main import app
from rest.routers.public.traces import AuthResult, authenticate_api_key


def make_auth_result(project_id: str = "test-project") -> AuthResult:
    """Create an AuthResult for testing (paid plan, no limit)."""
    return AuthResult(
        project_id=project_id,
        workspace_id="test-workspace",
        workspace_project_ids=[project_id],
        billing_plan="pro",
        free_plan_limit=None,
    )


@pytest.fixture()
def client(monkeypatch):
    """TestClient with mocked auth, S3, Celery, and protobuf decode."""
    app.dependency_overrides[authenticate_api_key] = lambda: make_auth_result()

    mock_payload = {"resourceSpans": [{"resource": {}, "scopeSpans": []}]}
    monkeypatch.setattr(
        "rest.routers.public.traces.decode_otlp_protobuf",
        lambda body: mock_payload,
    )

    mock_s3 = MagicMock()
    monkeypatch.setattr("rest.routers.public.traces.get_s3_service", lambda: mock_s3)

    mock_task = MagicMock()
    monkeypatch.setattr("rest.routers.public.traces.process_s3_traces", mock_task)

    yield TestClient(app), mock_s3, mock_task


class TestIngestTraces:
    def test_valid_protobuf(self, client):
        test_client, mock_s3, mock_task = client
        response = test_client.post(
            "/api/v1/public/traces",
            content=b"fake-protobuf-bytes",
        )
        assert response.status_code == 200
        data = response.json()
        assert data["status"] == "ok"
        assert "file_key" in data
        mock_s3.ensure_bucket_exists.assert_called_once()
        mock_s3.upload_json.assert_called_once()
        mock_task.delay.assert_called_once()

    def test_gzip_compressed(self, client, monkeypatch):
        test_client, _mock_s3, _mock_task = client

        raw_bytes = b"fake-protobuf-bytes"
        mock_decode = MagicMock(return_value={"resourceSpans": []})
        monkeypatch.setattr("rest.routers.public.traces.decode_otlp_protobuf", mock_decode)

        compressed = gzip.compress(raw_bytes)
        response = test_client.post(
            "/api/v1/public/traces",
            content=compressed,
            headers={"Content-Encoding": "gzip"},
        )
        assert response.status_code == 200
        mock_decode.assert_called_once_with(raw_bytes)

    def test_empty_body_returns_400(self):
        app.dependency_overrides[authenticate_api_key] = lambda: make_auth_result()
        test_client = TestClient(app)
        response = test_client.post("/api/v1/public/traces", content=b"")
        assert response.status_code == 400

    def test_invalid_protobuf_returns_400(self, monkeypatch):
        app.dependency_overrides[authenticate_api_key] = lambda: make_auth_result()
        monkeypatch.setattr(
            "rest.routers.public.traces.decode_otlp_protobuf",
            MagicMock(side_effect=Exception("Invalid protobuf")),
        )
        test_client = TestClient(app)
        response = test_client.post("/api/v1/public/traces", content=b"garbage-data")
        assert response.status_code == 400

    def test_invalid_gzip_returns_400(self):
        app.dependency_overrides[authenticate_api_key] = lambda: make_auth_result()
        test_client = TestClient(app)
        response = test_client.post(
            "/api/v1/public/traces",
            content=b"not-gzip-data",
            headers={"Content-Encoding": "gzip"},
        )
        assert response.status_code == 400

    def test_s3_failure_returns_500(self, client):
        test_client, mock_s3, _ = client
        mock_s3.upload_json.side_effect = Exception("S3 connection refused")
        response = test_client.post("/api/v1/public/traces", content=b"fake-protobuf")
        assert response.status_code == 500

    def test_celery_failure_still_returns_200(self, client):
        """Celery enqueue failure is logged but response is still 200 (S3 has the data)."""
        test_client, _mock_s3, mock_task = client
        mock_task.delay.side_effect = Exception("Redis down")
        response = test_client.post("/api/v1/public/traces", content=b"fake-protobuf")
        assert response.status_code == 200

    def test_s3_key_time_partitioned_format(self, client):
        test_client, mock_s3, _ = client
        test_client.post("/api/v1/public/traces", content=b"fake-protobuf")
        s3_key = mock_s3.upload_json.call_args[0][0]
        assert s3_key.startswith("events/otel/test-project/")
        assert s3_key.endswith(".json")
        # Should have yyyy/mm/dd/hh structure
        parts = s3_key.split("/")
        assert len(parts) == 8  # events/otel/proj/yyyy/mm/dd/hh/uuid.json

    def test_celery_task_receives_correct_args(self, client):
        test_client, _mock_s3, mock_task = client
        test_client.post("/api/v1/public/traces", content=b"fake-protobuf")
        kw = mock_task.delay.call_args.kwargs
        assert kw["project_id"] == "test-project"
        assert kw["s3_key"].startswith("events/otel/test-project/")

    def test_s3_receives_decoded_payload(self, client, monkeypatch):
        test_client, mock_s3, _ = client
        decoded = {"resourceSpans": [{"custom": "data"}]}
        monkeypatch.setattr("rest.routers.public.traces.decode_otlp_protobuf", lambda _: decoded)
        test_client.post("/api/v1/public/traces", content=b"protobuf-bytes")
        uploaded_data = mock_s3.upload_json.call_args[0][1]
        assert uploaded_data == decoded


class TestIngestNoAuth:
    """Tests without auth override — verify auth dependency is enforced."""

    def test_missing_auth_header(self):
        """Without dependency override, missing auth header causes failure."""
        # Don't override authenticate_api_key — let it run for real.
        # httpx call to Next.js will fail (no server running), resulting in error.
        test_client = TestClient(app, raise_server_exceptions=False)
        response = test_client.post("/api/v1/public/traces", content=b"data")
        # Should be 401 (missing header) or 503 (auth service down)
        assert response.status_code in (401, 503)
