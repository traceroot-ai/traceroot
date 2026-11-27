"""Production-label gateway and target scope checks."""

import asyncio
import json
from datetime import UTC, datetime, timedelta
from unittest.mock import AsyncMock, MagicMock

import pytest
import respx
from fastapi import HTTPException
from fastapi.testclient import TestClient
from httpx import ReadTimeout, Response

from rest.main import app
from rest.routers.labels_common import (
    LabeledTraceIds,
    find_labeled_trace_ids,
    resolve_labeled_trace_ids,
)
from rest.routers.public.deps import AuthResult, authenticate_api_key
from rest.services.filters.translate import Predicate
from rest.services.trace_reader import TraceReaderService
from shared.config import settings
from shared.enums import EVALUATION_SPAN_KINDS

_PUBLIC = "/api/v1/public/labels"
_INTERNAL = "/api/v1/internal/label-target"
_PAYLOAD = {
    "trace_id": "trace",
    "value": "incorrect",
    "author_id": "customer-42",
    "idempotency_key": "request-1",
}


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
        "authorId": "customer-42",
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


def test_write_requires_an_end_user_author(client, trace_reader):
    response = client.post(_PUBLIC, json={**_PAYLOAD, "author_id": " "})

    assert response.status_code == 422
    assert isinstance(response.json()["detail"], str)
    assert "author_id" in response.json()["detail"]
    trace_reader.get_label_target_start_time.assert_not_called()


def test_target_reader_failure_returns_fixed_error(client, trace_reader, caplog):
    trace_reader.get_label_target_start_time.side_effect = RuntimeError("database detail")

    response = client.post(_PUBLIC, json=_PAYLOAD)

    assert response.status_code == 500
    assert response.json() == {"detail": "Failed to verify label target"}
    assert "Failed to verify label target in project project" in caplog.text


@respx.mock
async def test_label_lookup_reads_trace_ids(monkeypatch):
    monkeypatch.setattr(settings, "internal_api_secret", "test-secret")
    route = respx.get(f"{settings.traceroot_ui_url.rstrip('/')}/api/internal/labels").mock(
        return_value=Response(200, json={"traceIds": ["trace"], "overflow": False})
    )

    result = await find_labeled_trace_ids(
        "project", "review", trace_ids=["trace", "other"], after_trace_id="cursor"
    )
    sent = route.calls.last.request
    assert dict(sent.url.params) == {
        "projectId": "project",
        "value": "review",
        "afterTraceId": "cursor",
        "traceId": "trace",
    }
    assert sent.url.params.get_list("traceId") == ["trace", "other"]
    assert sent.headers["X-Internal-Secret"] == "test-secret"
    assert result.trace_ids == ["trace"]
    assert result.overflow is False


@respx.mock
@pytest.mark.parametrize(
    ("failure", "logged"),
    [
        (Response(502), "HTTPStatusError (upstream status: 502)"),
        (Response(200, json={"invalid": "review"}), "ValidationError"),
        (ReadTimeout("review"), "ReadTimeout"),
    ],
)
async def test_label_lookup_logs_upstream_failures(failure, logged, caplog):
    route = respx.get(f"{settings.traceroot_ui_url.rstrip('/')}/api/internal/labels")
    if isinstance(failure, Response):
        route.mock(return_value=failure)
    else:
        route.mock(side_effect=failure)

    with pytest.raises(HTTPException) as exc:
        await find_labeled_trace_ids("project", "review")

    assert exc.value.status_code == 503
    assert logged in caplog.text
    assert "review" not in caplog.text


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


def test_matching_label_candidates_uses_the_trace_list_scope():
    reader = TraceReaderService.__new__(TraceReaderService)
    reader._client = MagicMock()
    reader._client.query.return_value.result_rows = [("recent",)]
    end = datetime(2026, 11, 25, tzinfo=UTC)
    start = end - timedelta(hours=1)

    assert reader.matching_trace_ids(
        ["old", "recent"],
        project_id="project",
        name=None,
        user_id="customer-42",
        start_after=start,
        end_before=end,
        search_query=None,
        filters=[Predicate(field="model_name", op="in", value=["gpt-4"])],
        include_evaluations=False,
    ) == ["recent"]

    command = reader._client.query.call_args
    sql = command.args[0]
    assert "SELECT t.trace_id" in sql
    assert "t.source = 'user'" in sql
    assert "t.user_id = {user_id:String}" in sql
    assert "t.trace_start_time >= {start_after:DateTime64(3)}" in sql
    assert "t.trace_start_time < {end_before:DateTime64(3)}" in sql
    assert "NOT IN (SELECT trace_id FROM traces" in sql
    assert command.kwargs["parameters"]["trace_ids"] == ["old", "recent"]
    assert ["gpt-4"] in command.kwargs["parameters"].values()


async def test_label_lookup_enforces_the_overall_time_budget(monkeypatch, caplog):
    monkeypatch.setattr("rest.routers.labels_common.LABEL_LOOKUP_TIMEOUT_S", 0.01)

    async def stalled_lookup(*args, **kwargs):
        await asyncio.Event().wait()

    monkeypatch.setattr("rest.routers.labels_common.find_labeled_trace_ids", stalled_lookup)
    match_batch = MagicMock()
    with pytest.raises(HTTPException) as exc:
        await resolve_labeled_trace_ids("project", "review", None, 100, match_batch)

    assert exc.value.status_code == 503
    assert "Label lookup exceeded its time budget in project project" in caplog.text
    match_batch.assert_not_called()


async def test_label_lookup_rejects_a_repeated_page_from_an_older_control_plane(monkeypatch):
    lookup = AsyncMock(return_value=LabeledTraceIds(traceIds=["trace"], overflow=True))
    monkeypatch.setattr("rest.routers.labels_common.find_labeled_trace_ids", lookup)
    match_batch = MagicMock(return_value=["trace"])

    with pytest.raises(HTTPException) as exc:
        await resolve_labeled_trace_ids("project", "review", None, 100, match_batch)

    assert exc.value.status_code == 503
    assert lookup.await_count == 2
    match_batch.assert_called_once_with(["trace"])
