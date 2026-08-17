"""Unit tests for the internal project-scoped detector read endpoints."""

from datetime import UTC, datetime

import pytest
from fastapi.testclient import TestClient

from rest.main import app
from rest.pagination import encode_cursor
from rest.retention import get_retention_cutoff
from rest.routers.deps import ProjectAccessInfo, get_project_access
from rest.schemas.public import (
    DetectorDetail,
    DetectorItem,
    DetectorResultItem,
    FindingDetail,
    FindingSummary,
    RCAResult,
)
from rest.services.detector_reader import get_detector_reader_service


def _now_naive():
    return datetime.now(UTC).replace(tzinfo=None)


class FakeReader:
    def __init__(self):
        self.detectors_args: dict | None = None
        self.detectors_return: tuple = ([], 0)
        self.raise_on_detectors = False
        self.list_args: dict | None = None
        self.list_return: tuple = ([], 0)
        self.raise_on_list = False
        self.raise_on_get_finding_by_trace = False
        self.raise_on_get_finding = False
        self.raise_on_get_detector = False
        self.finding: FindingDetail | None = None
        self.by_trace: FindingDetail | None = None
        self.last_get: tuple | None = None
        self.last_by_trace: tuple | None = None
        self.detector: object | None = None
        self.last_get_detector: tuple | None = None

    def list_detectors(self, **kwargs):
        self.detectors_args = kwargs
        if self.raise_on_detectors:
            raise RuntimeError("boom")
        return self.detectors_return

    def list_findings(self, **kwargs):
        self.list_args = kwargs
        if self.raise_on_list:
            raise RuntimeError("boom")
        return self.list_return

    def get_finding(self, project_id, finding_id):
        self.last_get = (project_id, finding_id)
        if self.raise_on_get_finding:
            raise RuntimeError("boom")
        return self.finding

    def get_finding_by_trace(self, project_id, trace_id):
        self.last_by_trace = (project_id, trace_id)
        if self.raise_on_get_finding_by_trace:
            raise RuntimeError("boom")
        return self.by_trace

    def get_detector(self, project_id, detector_id):
        self.last_get_detector = (project_id, detector_id)
        if self.raise_on_get_detector:
            raise RuntimeError("boom")
        return self.detector


def _detector(i: int = 1) -> DetectorItem:
    return DetectorItem(
        detector_id=f"det-{i}",
        name=f"Detector {i}",
        template="error-rate",
        enabled=True,
        created_at=datetime(2026, 8, 1, 12, 0, 0),
    )


def _finding_summary(finding_id: str = "f-1", timestamp: datetime | None = None) -> FindingSummary:
    return FindingSummary(
        finding_id=finding_id,
        project_id="proj-A",
        trace_id="t-1",
        summary="Elevated error rate",
        timestamp=timestamp or _now_naive(),
        detectors=["Detector 1"],
    )


def _finding(timestamp: datetime | None = None) -> FindingDetail:
    return FindingDetail(
        finding_id="f-1",
        project_id="proj-A",
        trace_id="t-1",
        summary="Elevated error rate",
        timestamp=timestamp or _now_naive(),
        detectors=["Detector 1"],
        results=[
            DetectorResultItem(
                detector_id="det-1",
                detector_name="Detector 1",
                template="error-rate",
                summary="errors spiked",
                identified=True,
                data={"count": 3},
            )
        ],
        rca=RCAResult(status="completed", result="Root cause: bad deploy"),
    )


@pytest.fixture()
def reader():
    return FakeReader()


def _make_client(reader: FakeReader, billing_plan: str) -> TestClient:
    """Build a TestClient with auth + reader overrides for one billing plan.

    Args:
        reader (FakeReader): Fake detector reader returned by the service dep.
        billing_plan (str): Plan stamped on the mocked project access.

    Returns:
        TestClient: Client against the app with overrides installed.
    """

    async def mock_get_access(project_id: str, x_user_id=None):
        return ProjectAccessInfo(
            project_id=project_id,
            user_id="test-user",
            role="ADMIN",
            workspace_id="ws-test",
            billing_plan=billing_plan,
        )

    app.dependency_overrides[get_project_access] = mock_get_access
    app.dependency_overrides[get_detector_reader_service] = lambda: reader
    return TestClient(app)


@pytest.fixture()
def client(reader):
    yield _make_client(reader, "enterprise")
    app.dependency_overrides.clear()


@pytest.fixture()
def free_plan_client(reader):
    yield _make_client(reader, "free")
    app.dependency_overrides.clear()


class TestListDetectors:
    def test_200_returns_page_and_scopes_to_project(self, client, reader):
        reader.detectors_return = ([_detector()], 1)
        resp = client.get("/api/v1/projects/proj-A/detectors")
        assert resp.status_code == 200
        body = resp.json()
        assert body["data"][0]["detector_id"] == "det-1"
        assert body["meta"]["total"] == 1
        assert reader.detectors_args["project_id"] == "proj-A"

    def test_window_params_pass_through(self, client, reader):
        resp = client.get(
            "/api/v1/projects/proj-A/detectors",
            params={
                "limit": 5,
                "start_after": "2026-08-01T00:00:00Z",
                "end_before": "2026-08-10T00:00:00Z",
            },
        )
        assert resp.status_code == 200
        assert reader.detectors_args["limit"] == 5
        assert reader.detectors_args["start_after"] is not None
        assert reader.detectors_args["end_before"] is not None

    def test_reader_error_maps_to_500(self, client, reader):
        reader.raise_on_detectors = True
        resp = client.get("/api/v1/projects/proj-A/detectors")
        assert resp.status_code == 500
        assert resp.json()["detail"] == "Failed to list detectors"


class TestListFindings:
    def test_200_with_filters_passed_through(self, client, reader):
        reader.list_return = ([], 0)
        resp = client.get(
            "/api/v1/projects/proj-A/detectors/findings",
            params={"detector": "error-rate", "trace_id": "t-9", "limit": 10},
        )
        assert resp.status_code == 200
        assert reader.list_args["project_id"] == "proj-A"
        assert reader.list_args["detector"] == "error-rate"
        assert reader.list_args["trace_id"] == "t-9"
        assert reader.list_args["limit"] == 10

    def test_free_plan_clamps_start_after_to_retention_cutoff(self, free_plan_client, reader):
        resp = free_plan_client.get("/api/v1/projects/proj-A/detectors/findings")
        assert resp.status_code == 200
        clamped = reader.list_args["start_after"]
        expected_cutoff = get_retention_cutoff("free")
        assert expected_cutoff is not None
        assert abs((clamped - expected_cutoff).total_seconds()) < 60

    def test_reader_error_maps_to_500(self, client, reader):
        reader.raise_on_list = True
        resp = client.get("/api/v1/projects/proj-A/detectors/findings")
        assert resp.status_code == 500
        assert resp.json()["detail"] == "Failed to list findings"


class TestListFindingsPagination:
    def test_full_page_emits_next_cursor_of_last_row(self, client, reader):
        rows = [
            _finding_summary(
                finding_id=f"f-{i}", timestamp=datetime(2026, 8, 17, 19, 3, 46, 820000)
            )
            for i in range(3)
        ]
        reader.list_return = (rows, 10)
        resp = client.get("/api/v1/projects/proj-A/detectors/findings", params={"limit": 3})
        meta = resp.json()["meta"]
        expected = encode_cursor(datetime(2026, 8, 17, 19, 3, 46, 820000), "f-2")
        assert meta["next_cursor"] == expected

    def test_partial_page_has_no_next_cursor(self, client, reader):
        reader.list_return = ([_finding_summary(finding_id="f-1")], 10)
        resp = client.get("/api/v1/projects/proj-A/detectors/findings", params={"limit": 3})
        assert resp.json()["meta"]["next_cursor"] is None

    def test_cursor_param_is_decoded_and_passed_to_reader(self, client, reader):
        ts = datetime(2026, 8, 17, 19, 3, 46, 820000)
        token = encode_cursor(ts, "f-5")
        resp = client.get("/api/v1/projects/proj-A/detectors/findings", params={"cursor": token})
        assert resp.status_code == 200
        assert reader.list_args["cursor"] == (ts, "f-5")

    def test_invalid_cursor_is_422(self, client, reader):
        resp = client.get(
            "/api/v1/projects/proj-A/detectors/findings", params={"cursor": "garbage!!"}
        )
        assert resp.status_code == 422
        assert resp.json()["detail"] == "Invalid cursor"
        assert reader.list_args is None  # rejected before the reader ran


class TestListDetectorsPagination:
    def test_full_page_emits_next_cursor_of_last_row(self, client, reader):
        reader.detectors_return = ([_detector(i) for i in range(3)], 10)
        resp = client.get("/api/v1/projects/proj-A/detectors", params={"limit": 3})
        meta = resp.json()["meta"]
        expected = encode_cursor(datetime(2026, 8, 1, 12, 0, 0), "det-2")
        assert meta["next_cursor"] == expected

    def test_partial_page_has_no_next_cursor(self, client, reader):
        reader.detectors_return = ([_detector()], 10)
        resp = client.get("/api/v1/projects/proj-A/detectors", params={"limit": 3})
        assert resp.json()["meta"]["next_cursor"] is None

    def test_cursor_param_is_decoded_and_passed_to_reader(self, client, reader):
        ts = datetime(2026, 8, 17, 19, 3, 46, 820000)
        token = encode_cursor(ts, "det-5")
        resp = client.get("/api/v1/projects/proj-A/detectors", params={"cursor": token})
        assert resp.status_code == 200
        assert reader.detectors_args["cursor"] == (ts, "det-5")

    def test_invalid_cursor_is_422(self, client, reader):
        resp = client.get("/api/v1/projects/proj-A/detectors", params={"cursor": "garbage!!"})
        assert resp.status_code == 422
        assert resp.json()["detail"] == "Invalid cursor"
        assert reader.detectors_args is None  # rejected before the reader ran


class TestGetFinding:
    def test_200_includes_results_and_rca(self, client, reader):
        reader.finding = _finding()
        resp = client.get("/api/v1/projects/proj-A/detectors/findings/f-1")
        assert resp.status_code == 200
        body = resp.json()
        assert body["finding_id"] == "f-1"
        assert body["results"][0]["detector_name"] == "Detector 1"
        assert body["rca"]["result"] == "Root cause: bad deploy"
        assert reader.last_get == ("proj-A", "f-1")

    def test_missing_finding_is_404(self, client, reader):
        reader.finding = None
        resp = client.get("/api/v1/projects/proj-A/detectors/findings/nope")
        assert resp.status_code == 404

    def test_free_plan_out_of_retention_is_403(self, free_plan_client, reader):
        reader.finding = _finding(timestamp=datetime(2020, 1, 1))
        resp = free_plan_client.get("/api/v1/projects/proj-A/detectors/findings/f-1")
        assert resp.status_code == 403

    def test_reader_error_maps_to_500(self, client, reader):
        reader.raise_on_get_finding = True
        resp = client.get("/api/v1/projects/proj-A/detectors/findings/f-1")
        assert resp.status_code == 500
        assert resp.json()["detail"] == "Failed to read finding"


class TestGetFindingByTrace:
    def test_200_scopes_to_project_and_trace(self, client, reader):
        reader.by_trace = _finding()
        resp = client.get("/api/v1/projects/proj-A/detectors/traces/t-1/finding")
        assert resp.status_code == 200
        assert resp.json()["trace_id"] == "t-1"
        assert reader.last_by_trace == ("proj-A", "t-1")

    def test_missing_finding_is_404(self, client, reader):
        reader.by_trace = None
        resp = client.get("/api/v1/projects/proj-A/detectors/traces/t-x/finding")
        assert resp.status_code == 404

    def test_reader_error_maps_to_500(self, client, reader):
        reader.raise_on_get_finding_by_trace = True
        resp = client.get("/api/v1/projects/proj-A/detectors/traces/t-1/finding")
        assert resp.status_code == 500
        assert resp.json()["detail"] == "Failed to read finding"


def _detector_detail() -> DetectorDetail:
    return DetectorDetail(
        detector_id="det-1",
        name="Error spike",
        template="failure",
        enabled=True,
        created_at=datetime(2026, 8, 1, 12, 0, 0),
        prompt="Flag traces with elevated error rates",
        output_schema={"type": "object"},
        sample_rate=25,
        enable_rca=True,
        detection_model="claude-haiku-4-5",
        detection_provider="anthropic",
        detection_source="system",
        updated_at=datetime(2026, 8, 2, 9, 0, 0),
        trigger_conditions=[{"field": "root_span_finished", "op": "=", "value": True}],
    )


class TestGetDetector:
    def test_200_returns_full_config(self, client, reader):
        reader.detector = _detector_detail()
        resp = client.get("/api/v1/projects/proj-A/detectors/det-1")
        assert resp.status_code == 200
        body = resp.json()
        assert body["detector_id"] == "det-1"
        assert body["prompt"] == "Flag traces with elevated error rates"
        assert body["sample_rate"] == 25
        assert body["trigger_conditions"] == [
            {"field": "root_span_finished", "op": "=", "value": True}
        ]
        assert reader.last_get_detector == ("proj-A", "det-1")

    def test_missing_detector_is_404(self, client, reader):
        reader.detector = None
        resp = client.get("/api/v1/projects/proj-A/detectors/nope")
        assert resp.status_code == 404
        assert resp.json()["detail"] == "Detector not found"

    def test_reader_error_maps_to_500(self, client, reader):
        reader.raise_on_get_detector = True
        resp = client.get("/api/v1/projects/proj-A/detectors/det-1")
        assert resp.status_code == 500
        assert resp.json()["detail"] == "Failed to read detector"

    def test_findings_path_is_not_shadowed_by_detector_id(self, client, reader):
        reader.list_return = ([], 0)
        resp = client.get("/api/v1/projects/proj-A/detectors/findings")
        assert resp.status_code == 200
        assert reader.list_args is not None
        assert reader.last_get_detector is None
