"""Unit tests for the internal trace detection-state endpoint.

The trace page uses this to know whether detector results are coming, and which
runs to expect, instead of guessing with a timer. It reads the worker's per-trace
enqueue-claim record and is deliberately fail-soft: a hint, not page data.
"""

import json
from unittest.mock import AsyncMock, MagicMock

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
def mock_redis(monkeypatch):
    """Mock the async Redis client the endpoint reads the claim record from."""
    mock = MagicMock()
    mock.get = AsyncMock(return_value=None)
    monkeypatch.setattr("shared.redis.get_async_redis_client", lambda: mock)
    return mock


@pytest.fixture()
def client(secret, mock_redis):
    return TestClient(app)


class TestTraceDetectionState:
    URL = "/api/v1/internal/traces/trace-abc/detection-state"

    def _get(self, client, secret):
        return client.get(
            self.URL, params={"project_id": "p1"}, headers={"X-Internal-Secret": secret}
        )

    def test_reports_pending_with_expected_detectors(self, client, mock_redis, secret):
        # The detector ids are what let the client stop polling exactly when
        # every enqueued run has landed.
        mock_redis.get.return_value = json.dumps(
            {"state": "pending", "detector_ids": ["d1", "d2"], "token": "t"}
        )
        resp = self._get(client, secret)
        assert resp.status_code == 200
        assert resp.json() == {"state": "pending", "detector_ids": ["d1", "d2"]}

    def test_reports_sampled_out(self, client, mock_redis, secret):
        # A sticky "nothing will ever appear": the client must not poll at all.
        mock_redis.get.return_value = json.dumps({"state": "sampled_out", "token": "t"})
        resp = self._get(client, secret)
        assert resp.json() == {"state": "sampled_out", "detector_ids": []}

    def test_reads_the_worker_claim_key(self, client, mock_redis, secret):
        self._get(client, secret)
        # Same key the worker claims under (shared.detector_keys).
        mock_redis.get.assert_awaited_once_with("detector-enq:p1:trace-abc")

    def test_missing_record_is_no_signal(self, client, mock_redis, secret):
        # Expired or never detected. Absence is not a promise of nothing, so the
        # client falls back to its own window rather than giving up.
        mock_redis.get.return_value = None
        resp = self._get(client, secret)
        assert resp.json() == {"state": None, "detector_ids": []}

    def test_unrecognized_future_state_is_not_leaked(self, client, mock_redis, secret):
        mock_redis.get.return_value = json.dumps({"state": "quarantined"})
        resp = self._get(client, secret)
        assert resp.json() == {"state": None, "detector_ids": []}

    def test_undecodable_payload_fails_soft(self, client, mock_redis, secret):
        mock_redis.get.return_value = "not-json"
        resp = self._get(client, secret)
        assert resp.status_code == 200
        assert resp.json() == {"state": None, "detector_ids": []}

    def test_non_string_detector_ids_are_dropped(self, client, mock_redis, secret):
        mock_redis.get.return_value = json.dumps({"state": "pending", "detector_ids": ["d1", 7]})
        assert self._get(client, secret).json()["detector_ids"] == ["d1"]

    def test_redis_outage_fails_soft(self, client, mock_redis, secret):
        # A hint must never become a 500 on the trace page.
        mock_redis.get.side_effect = RuntimeError("connection refused")
        resp = self._get(client, secret)
        assert resp.status_code == 200
        assert resp.json() == {"state": None, "detector_ids": []}

    def test_requires_internal_secret(self, client, mock_redis):
        resp = client.get(self.URL, params={"project_id": "p1"})
        assert resp.status_code == 403
