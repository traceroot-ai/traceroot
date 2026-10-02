"""Unit tests for GET /internal/trace-counts: the chart population behind a
signal's "traces per bucket" overlay must match what the customer-facing
Traces list would show, not a raw scan of every row in `traces`.
"""

from unittest.mock import MagicMock

import pytest
from fastapi.testclient import TestClient

from rest.main import app
from shared.config import settings


@pytest.fixture()
def secret(monkeypatch):
    """Configure a known internal-secret so the auth dep accepts our header."""
    monkeypatch.setattr(settings, "internal_api_secret", "test-secret")
    return "test-secret"


@pytest.fixture()
def mock_ch(monkeypatch):
    mock = MagicMock()
    monkeypatch.setattr(
        "rest.routers.internal.detectors.get_clickhouse_client",
        lambda: mock,
    )
    return mock


@pytest.fixture()
def client(secret, mock_ch):
    return TestClient(app)


def _empty_result():
    r = MagicMock()
    r.result_rows = []
    return r


class TestTraceCountsExclusions:
    """The "all traces" population (no detector_id) must apply the same
    customer-traffic and evaluation exclusions as the Traces list."""

    def test_all_traces_population_excludes_internal_and_eval_traces(self, client, mock_ch, secret):
        mock_ch.query.return_value = _empty_result()
        response = client.get(
            "/api/v1/internal/trace-counts",
            params={
                "project_id": "p1",
                "start_after": "2026-01-01T00:00:00",
                "end_before": "2026-01-02T00:00:00",
            },
            headers={"X-Internal-Secret": secret},
        )
        assert response.status_code == 200
        sql = mock_ch.query.call_args.args[0]
        assert "source = 'user'" in sql
        assert "is_evaluation = 1" in sql

    def test_detector_scoped_population_also_excludes_internal_and_eval_traces(
        self, client, mock_ch, secret
    ):
        mock_ch.query.return_value = _empty_result()
        response = client.get(
            "/api/v1/internal/trace-counts",
            params={
                "project_id": "p1",
                "start_after": "2026-01-01T00:00:00",
                "end_before": "2026-01-02T00:00:00",
                "detector_id": "d1",
            },
            headers={"X-Internal-Secret": secret},
        )
        assert response.status_code == 200
        sql = mock_ch.query.call_args.args[0]
        assert "source = 'user'" in sql
        assert "is_evaluation = 1" in sql
