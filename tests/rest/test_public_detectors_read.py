"""API tests for the public detector findings read endpoints.

Auth is overridden and the reader service is replaced with a fake, so these run
with no live databases.
"""

from datetime import datetime

import pytest
from fastapi.testclient import TestClient

from rest.main import app
from rest.routers.public.deps import AuthResult, authenticate_api_key
from rest.schemas.public import (
    DetectorItem,
    DetectorResultItem,
    FindingDetail,
    FindingSummary,
    RCAResult,
)
from rest.services.detector_reader import get_detector_reader_service


def make_auth(project_id: str = "proj-A") -> AuthResult:
    return AuthResult(
        project_id=project_id,
        workspace_id="ws-1",
        billing_plan="pro",
        ingestion_blocked=False,
    )


class FakeReader:
    def __init__(self):
        self.list_args: dict | None = None
        self.list_return: tuple = ([], 0)
        self.raise_on_list = False
        self.detectors_args: dict | None = None
        self.detectors_return: tuple = ([], 0)
        self.raise_on_detectors = False
        self.finding: FindingDetail | None = None
        self.by_trace: FindingDetail | None = None
        self.last_get: tuple | None = None
        self.last_by_trace: tuple | None = None

    def list_findings(self, **kwargs):
        self.list_args = kwargs
        if self.raise_on_list:
            raise RuntimeError("boom")
        return self.list_return

    def list_detectors(self, **kwargs):
        self.detectors_args = kwargs
        if self.raise_on_detectors:
            raise RuntimeError("boom")
        return self.detectors_return

    def get_finding(self, project_id, finding_id):
        self.last_get = (project_id, finding_id)
        return self.finding

    def get_finding_by_trace(self, project_id, trace_id):
        self.last_by_trace = (project_id, trace_id)
        return self.by_trace


@pytest.fixture()
def reader():
    return FakeReader()


@pytest.fixture()
def client(reader):
    # conftest's autouse fixture clears app.dependency_overrides after each test.
    app.dependency_overrides[authenticate_api_key] = lambda: make_auth()
    app.dependency_overrides[get_detector_reader_service] = lambda: reader
    return TestClient(app)


def _summary(**over):
    base = dict(
        finding_id="f1",
        project_id="proj-A",
        trace_id="t1",
        summary="s",
        timestamp=datetime(2026, 6, 29, 10, 42),
        detectors=["hallucination"],
    )
    base.update(over)
    return FindingSummary(**base)


def _detail(**over):
    base = dict(
        finding_id="f1",
        project_id="proj-A",
        trace_id="t1",
        summary="s",
        timestamp=datetime(2026, 6, 29, 10, 42),
        detectors=["hallucination"],
        results=[
            DetectorResultItem(
                detector_id="d1",
                detector_name="hallucination",
                template="hallucination",
                summary="x",
                identified=True,
                data={"k": "v"},
            )
        ],
        rca=RCAResult(status="done", result="rc"),
    )
    base.update(over)
    return FindingDetail(**base)


def _detector(**over):
    base = dict(
        detector_id="d1",
        name="My Hallucination Detector",
        template="hallucination",
        enabled=True,
        created_at=datetime(2026, 6, 29, 10, 42),
    )
    base.update(over)
    return DetectorItem(**base)


def test_list_detectors_returns_items_with_pagination_meta(client, reader):
    reader.detectors_return = ([_detector()], 1)
    resp = client.get("/api/v1/public/detectors")
    assert resp.status_code == 200
    body = resp.json()
    assert body["meta"] == {"page": 0, "limit": 50, "total": 1}
    assert body["data"][0]["detector_id"] == "d1"
    assert body["data"][0]["template"] == "hallucination"
    assert body["data"][0]["enabled"] is True


def test_list_detectors_forwards_limit_and_project_scope(client, reader):
    client.get("/api/v1/public/detectors?limit=10")
    args = reader.detectors_args
    assert args["project_id"] == "proj-A"
    assert args["limit"] == 10


def test_list_detectors_forwards_time_window(client, reader):
    client.get(
        "/api/v1/public/detectors?start_after=2026-06-01T00:00:00Z&end_before=2026-06-30T00:00:00Z"
    )
    args = reader.detectors_args
    assert args["start_after"] is not None
    assert args["end_before"] is not None


@pytest.mark.parametrize("limit", [0, 500])
def test_list_detectors_rejects_out_of_range_limit(client, limit):
    assert client.get(f"/api/v1/public/detectors?limit={limit}").status_code == 422


def test_list_detectors_reader_failure_returns_sanitized_500(client, reader):
    reader.raise_on_detectors = True
    resp = client.get("/api/v1/public/detectors")
    assert resp.status_code == 500
    assert resp.json()["detail"] == "Failed to list detectors"
    assert "boom" not in resp.text


def test_list_detectors_auth_required_without_key(reader):
    app.dependency_overrides[get_detector_reader_service] = lambda: reader
    resp = TestClient(app).get("/api/v1/public/detectors")
    assert resp.status_code in (401, 403)


def test_list_returns_findings_with_pagination_meta(client, reader):
    reader.list_return = ([_summary()], 1)
    resp = client.get("/api/v1/public/detectors/findings")
    assert resp.status_code == 200
    body = resp.json()
    assert body["meta"] == {"page": 0, "limit": 50, "total": 1}
    assert body["data"][0]["finding_id"] == "f1"
    assert body["data"][0]["detectors"] == ["hallucination"]


def test_list_empty_returns_200_with_empty_data(client, reader):
    reader.list_return = ([], 0)
    resp = client.get("/api/v1/public/detectors/findings")
    assert resp.status_code == 200
    body = resp.json()
    assert body["data"] == []
    assert body["meta"] == {"page": 0, "limit": 50, "total": 0}


def test_list_forwards_filters_and_project_scope(client, reader):
    client.get(
        "/api/v1/public/detectors/findings"
        "?limit=10&detector=hallucination&trace_id=t9"
        "&start_after=2026-06-01T00:00:00Z&end_before=2026-06-30T00:00:00Z"
    )
    args = reader.list_args
    assert args["project_id"] == "proj-A"
    assert args["limit"] == 10
    assert args["detector"] == "hallucination"
    assert args["trace_id"] == "t9"
    assert args["start_after"] is not None
    assert args["end_before"] is not None


@pytest.mark.parametrize("limit", [0, 500])
def test_list_rejects_out_of_range_limit(client, limit):
    assert client.get(f"/api/v1/public/detectors/findings?limit={limit}").status_code == 422


def test_list_reader_failure_returns_sanitized_500(client, reader):
    reader.raise_on_list = True
    resp = client.get("/api/v1/public/detectors/findings")
    assert resp.status_code == 500
    assert resp.json()["detail"] == "Failed to list findings"
    assert "boom" not in resp.text


def test_detail_by_finding_id_returns_results_and_rca(client, reader):
    reader.finding = _detail()
    resp = client.get("/api/v1/public/detectors/findings/f1")
    assert resp.status_code == 200
    body = resp.json()
    assert reader.last_get == ("proj-A", "f1")
    assert body["results"][0]["detector_id"] == "d1"
    assert body["results"][0]["identified"] is True
    assert body["rca"] == {"status": "done", "result": "rc"}


def test_detail_without_rca_returns_null(client, reader):
    reader.finding = _detail(rca=None, results=[])
    body = client.get("/api/v1/public/detectors/findings/f1").json()
    assert body["rca"] is None


def test_detail_404_when_missing(client, reader):
    reader.finding = None
    assert client.get("/api/v1/public/detectors/findings/nope").status_code == 404


def test_detail_by_trace_returns_finding(client, reader):
    reader.by_trace = _detail(trace_id="t9", results=[], rca=None)
    resp = client.get("/api/v1/public/detectors/traces/t9/finding")
    assert resp.status_code == 200
    assert reader.last_by_trace == ("proj-A", "t9")
    assert resp.json()["trace_id"] == "t9"


def test_detail_by_trace_404_when_none(client, reader):
    reader.by_trace = None
    assert client.get("/api/v1/public/detectors/traces/none/finding").status_code == 404


def test_auth_required_without_key(reader):
    # Only the service is overridden; with no auth override the real key check runs
    # and a request without a key is rejected before reaching the reader.
    app.dependency_overrides[get_detector_reader_service] = lambda: reader
    resp = TestClient(app).get("/api/v1/public/detectors/findings")
    assert resp.status_code in (401, 403)
