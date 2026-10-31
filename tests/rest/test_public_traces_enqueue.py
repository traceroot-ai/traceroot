"""The ingest route answers 503 when the processing task cannot be queued."""

import logging
from unittest.mock import MagicMock

import pytest
from fastapi.testclient import TestClient

from rest.main import app
from rest.openapi_public import build_public_schema
from rest.routers.public.traces import AuthResult, authenticate_api_key

INGEST_URL = "/api/v1/public/traces"
PROTOBUF = {"Content-Type": "application/x-protobuf"}


@pytest.fixture()
def ingest(monkeypatch):
    """The ingest route with auth stubbed, and S3 and Celery mocked."""
    app.dependency_overrides[authenticate_api_key] = lambda: AuthResult(
        project_id="test-project",
        workspace_id="test-workspace",
        billing_plan="pro",
        ingestion_blocked=False,
    )
    s3 = MagicMock()
    monkeypatch.setattr("rest.routers.public.traces.get_s3_service", lambda: s3)
    task = MagicMock()
    monkeypatch.setattr("rest.routers.public.traces.process_s3_traces", task)
    return TestClient(app), s3, task


class TestEnqueueFailure:
    def test_enqueue_failure_is_503_with_retry_after(self, ingest):
        client, _, task = ingest
        task.delay.side_effect = Exception("Redis down")

        response = client.post(INGEST_URL, content=b"fake-protobuf", headers=PROTOBUF)

        assert response.status_code == 503
        assert response.headers["Retry-After"] == "5"
        assert response.json() == {
            "detail": "Could not queue the batch for processing. Retry shortly."
        }

    def test_enqueue_failure_is_logged_with_the_key(self, ingest, caplog):
        client, s3, task = ingest
        task.delay.side_effect = Exception("Redis down")

        with caplog.at_level(logging.ERROR, logger="rest.routers.public.traces"):
            client.post(INGEST_URL, content=b"fake-protobuf", headers=PROTOBUF)

        staged_key = s3.upload_bytes.call_args[0][0]
        errors = [r.getMessage() for r in caplog.records if r.levelno >= logging.ERROR]
        assert any(staged_key in m and "Redis down" in m for m in errors), errors

    def test_staged_object_is_left_in_place(self, ingest):
        """The batch was stored before the enqueue failed; nothing deletes it."""
        client, s3, task = ingest
        task.delay.side_effect = Exception("Redis down")

        client.post(INGEST_URL, content=b"fake-protobuf", headers=PROTOBUF)

        s3.upload_bytes.assert_called_once()
        assert not [c for c in s3.method_calls if "delete" in c[0]]

    def test_success_is_unchanged(self, ingest):
        client, s3, task = ingest

        response = client.post(INGEST_URL, content=b"fake-protobuf", headers=PROTOBUF)

        assert response.status_code == 200
        assert "Retry-After" not in response.headers
        body = response.json()
        assert body["status"] == "ok"
        assert body["file_key"] == s3.upload_bytes.call_args[0][0]
        task.delay.assert_called_once()
        kwargs = task.delay.call_args.kwargs
        assert kwargs["s3_key"] == body["file_key"]
        assert kwargs["project_id"] == "test-project"


def test_public_schema_documents_the_queueing_503():
    responses = build_public_schema(app)["paths"]["/api/v1/public/traces"]["post"]["responses"]
    assert responses["503"]["description"] == (
        "Authentication service unavailable, or the batch could not be queued"
    )
