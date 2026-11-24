"""Production-label gateway and target scope checks."""

import json
from datetime import UTC, datetime, timedelta
from unittest.mock import MagicMock

import pytest
import respx
from fastapi.testclient import TestClient
from httpx import Response

from rest.main import app
from rest.routers.public.deps import AuthResult, authenticate_api_key
from rest.services.trace_reader import TraceReaderService
from shared.config import settings
from shared.enums import EVALUATION_SPAN_KINDS

_PUBLIC = "/api/v1/public/labels"
_INTERNAL = "/api/v1/internal/label-target"
_PAYLOAD = {"trace_id": "trace", "value": "incorrect", "idempotency_key": "request-1"}


@pytest.fixture()
def client(monkeypatch):
    access = AuthResult(
        project_id="project", workspace_id="workspace", billing_plan="free", ingestion_blocked=False
    )
    app.dependency_overrides[authenticate_api_key] = lambda: access
    monkeypatch.setattr(settings, "internal_api_secret", "test-secret")
    yield TestClient(app)
    app.dependency_overrides.pop(authenticate_api_key, None)


@pytest.fixture()
def trace_reader(monkeypatch):
    reader = MagicMock()
    reader.get_label_target_start_time.return_value = datetime.now(UTC)
    monkeypatch.setattr("rest.routers.labels_common.get_trace_reader_service", lambda: reader)
    return reader


@respx.mock
def test_write_only_gateway_forwards_validated_target_from_key(client, trace_reader):
    route = respx.post(f"{settings.traceroot_ui_url}/api/internal/labels").mock(
        return_value=Response(200, json={"id": "label"})
    )
    assert client.post(_PUBLIC, json=_PAYLOAD).json() == {"id": "label"}
    assert client.get(_PUBLIC).status_code == 405
    trace_reader.get_label_target_start_time.assert_called_once_with("project", "trace", None)
    sent = route.calls.last.request
    assert sent.headers["X-Internal-Secret"] == "test-secret"
    assert json.loads(sent.content) == {
        "projectId": "project",
        "traceId": "trace",
        "value": "incorrect",
        "idempotencyKey": "request-1",
    }


@respx.mock
def test_same_key_conflict_stays_409(client, trace_reader):
    route = respx.post(f"{settings.traceroot_ui_url}/api/internal/labels").mock(
        return_value=Response(409, json={"error": "Conflicting assignment"})
    )
    response = client.post(_PUBLIC, json={**_PAYLOAD, "span_id": "span"})
    assert response.status_code == 409
    assert response.json() == {"detail": "Conflicting assignment"}
    assert json.loads(route.calls.last.request.content)["spanId"] == "span"


@pytest.mark.parametrize(("days_old", "code"), [(None, 404), (20, 403)])
def test_unknown_or_expired_target_is_rejected_before_write(client, trace_reader, days_old, code):
    trace_reader.get_label_target_start_time.return_value = (
        datetime.now(UTC) - timedelta(days=days_old) if days_old else None
    )
    assert client.post(_PUBLIC, json=_PAYLOAD).status_code == code


def test_internal_target_requires_secret_and_accepts_a_valid_span(client, trace_reader):
    params = {"projectId": "project", "traceId": "trace", "spanId": "span"}
    assert client.get(_INTERNAL, params=params).status_code == 403
    trace_reader.get_label_target_start_time.assert_not_called()
    headers = {"X-Internal-Secret": "test-secret"}
    assert client.get(_INTERNAL, params=params, headers=headers).status_code == 204
    trace_reader.get_label_target_start_time.assert_called_once_with("project", "trace", "span")


def test_label_target_query_checks_source_evaluation_markers_and_span_membership():
    reader = TraceReaderService.__new__(TraceReaderService)
    reader._client = MagicMock()
    reader._client.query.return_value.result_rows = []
    assert reader.get_label_target_start_time("project", "trace", "span") is None
    call = reader._client.query.call_args
    sql = call.args[0]
    assert sql.count("source = 'user'") == 2
    assert "is_evaluation = 1" in sql
    assert all(f"'{kind}'" in sql for kind in EVALUATION_SPAN_KINDS)
    assert sql.count("trace_id = {trace_id:String}") == 4
    assert "span_id = {span_id:String}" in sql
    assert call.kwargs["parameters"] == {
        "project_id": "project",
        "trace_id": "trace",
        "span_id": "span",
    }
