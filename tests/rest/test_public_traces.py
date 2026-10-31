"""Unit tests for public traces ingestion endpoint.

Uses FastAPI TestClient with mocked S3 and Celery.
"""

import gzip
from unittest.mock import MagicMock

import pytest
from fastapi.testclient import TestClient

from rest.main import app
from rest.routers.public.traces import AuthResult, authenticate_api_key


def make_auth_result(project_id: str = "test-project") -> AuthResult:
    """Create an AuthResult for testing (paid plan, not blocked)."""
    return AuthResult(
        project_id=project_id,
        workspace_id="test-workspace",
        billing_plan="pro",
        ingestion_blocked=False,
    )


@pytest.fixture()
def client(monkeypatch):
    """TestClient with mocked auth, S3 and Celery."""
    app.dependency_overrides[authenticate_api_key] = lambda: make_auth_result()

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
            headers={"Content-Type": "application/x-protobuf"},
        )
        assert response.status_code == 200
        data = response.json()
        assert data["status"] == "ok"
        assert "file_key" in data
        mock_s3.ensure_bucket_exists.assert_called_once()
        mock_s3.upload_bytes.assert_called_once()
        mock_task.delay.assert_called_once()

    def test_gzip_compressed(self, client):
        test_client, mock_s3, _mock_task = client

        compressed = gzip.compress(b"fake-protobuf-bytes")
        response = test_client.post(
            "/api/v1/public/traces",
            content=compressed,
            headers={"Content-Encoding": "gzip", "Content-Type": "application/x-protobuf"},
        )
        assert response.status_code == 200
        s3_key, staged = mock_s3.upload_bytes.call_args[0][:2]
        assert s3_key.endswith(".pb.gz")
        assert staged == compressed

    def test_empty_body_returns_400(self):
        app.dependency_overrides[authenticate_api_key] = lambda: make_auth_result()
        test_client = TestClient(app)
        response = test_client.post(
            "/api/v1/public/traces",
            content=b"",
            headers={"Content-Type": "application/x-protobuf"},
        )
        assert response.status_code == 400

    def test_invalid_protobuf_is_staged_for_the_worker(self, client):
        """The route no longer parses protobuf; the worker rejects a bad batch."""
        test_client, mock_s3, mock_task = client
        response = test_client.post(
            "/api/v1/public/traces",
            content=b"garbage-data",
            headers={"Content-Type": "application/x-protobuf"},
        )
        assert response.status_code == 200
        assert mock_s3.upload_bytes.call_args[0][1] == b"garbage-data"
        mock_task.delay.assert_called_once()

    def test_invalid_gzip_returns_400(self):
        app.dependency_overrides[authenticate_api_key] = lambda: make_auth_result()
        test_client = TestClient(app)
        response = test_client.post(
            "/api/v1/public/traces",
            content=b"not-gzip-data",
            headers={"Content-Encoding": "gzip", "Content-Type": "application/x-protobuf"},
        )
        assert response.status_code == 400
        assert response.json()["detail"] == "Invalid gzip payload"

    def test_s3_failure_returns_500(self, client):
        test_client, mock_s3, _ = client
        mock_s3.upload_bytes.side_effect = Exception("S3 connection refused")
        response = test_client.post(
            "/api/v1/public/traces",
            content=b"fake-protobuf",
            headers={"Content-Type": "application/x-protobuf"},
        )
        assert response.status_code == 500

    def test_s3_key_time_partitioned_format(self, client):
        test_client, mock_s3, _ = client
        test_client.post(
            "/api/v1/public/traces",
            content=b"fake-protobuf",
            headers={"Content-Type": "application/x-protobuf"},
        )
        s3_key = mock_s3.upload_bytes.call_args[0][0]
        assert s3_key.startswith("events/ingest/test-project/")
        assert s3_key.endswith(".pb")
        # Should have yyyy/mm/dd/hh structure
        parts = s3_key.split("/")
        assert len(parts) == 8  # events/ingest/proj/yyyy/mm/dd/hh/uuid.pb

    @pytest.mark.parametrize(
        ("headers", "encode"),
        [
            ({"Content-Type": "application/x-protobuf"}, lambda b: b),
            ({"Content-Encoding": "gzip", "Content-Type": "application/x-protobuf"}, gzip.compress),
        ],
        ids=["pb", "pb.gz"],
    )
    def test_s3_key_starts_with_events_ingest_and_the_project_id(self, client, headers, encode):
        test_client, mock_s3, mock_task = client
        app.dependency_overrides[authenticate_api_key] = lambda: make_auth_result("proj-42")
        response = test_client.post(
            "/api/v1/public/traces",
            content=encode(b"fake-protobuf"),
            headers=headers,
        )
        assert response.status_code == 200
        s3_key = mock_s3.upload_bytes.call_args[0][0]
        assert s3_key.startswith("events/ingest/proj-42/")
        assert response.json()["file_key"] == s3_key
        assert mock_task.delay.call_args.kwargs["s3_key"] == s3_key

    def test_celery_task_receives_correct_args(self, client):
        test_client, _mock_s3, mock_task = client
        test_client.post(
            "/api/v1/public/traces",
            content=b"fake-protobuf",
            headers={"Content-Type": "application/x-protobuf"},
        )
        kw = mock_task.delay.call_args.kwargs
        assert kw["project_id"] == "test-project"
        assert kw["s3_key"].startswith("events/ingest/test-project/")

    def test_s3_receives_the_body_as_sent(self, client):
        test_client, mock_s3, _ = client
        test_client.post(
            "/api/v1/public/traces",
            content=b"protobuf-bytes",
            headers={"Content-Type": "application/x-protobuf"},
        )
        uploaded_data = mock_s3.upload_bytes.call_args[0][1]
        assert uploaded_data == b"protobuf-bytes"


class TestContentTypeValidation:
    def test_missing_content_type_returns_415(self, client):
        test_client, _mock_s3, _ = client
        response = test_client.post("/api/v1/public/traces", content=b"fake-protobuf")
        assert response.status_code == 415
        assert response.json().get("detail") == "Content-Type must be application/x-protobuf"

    def test_invalid_content_type_returns_415(self, client):
        test_client, _mock_s3, _ = client
        response = test_client.post(
            "/api/v1/public/traces",
            content=b"fake-protobuf",
            headers={"Content-Type": "application/json"},
        )
        assert response.status_code == 415
        assert response.json().get("detail") == "Content-Type must be application/x-protobuf"

    def test_content_type_with_parameters_accepted(self, client):
        test_client, _mock_s3, _ = client
        response = test_client.post(
            "/api/v1/public/traces",
            content=b"fake-protobuf",
            headers={"Content-Type": "application/x-protobuf; charset=utf-8"},
        )
        assert response.status_code == 200


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
