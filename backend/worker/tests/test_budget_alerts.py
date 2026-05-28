"""Tests for the budget alert module.

Tests cover:
- Redis INCRBYFLOAT counter accumulation
- Threshold detection (below/at/above)
- Cooldown suppression (no duplicate alerts)
- Budget detector config caching
- BullMQ enqueue on threshold breach
- No-op when no budget detectors exist
"""

import json

# Patch psycopg2 and celery before importing the module under test
import sys
from unittest.mock import MagicMock, patch

# Create mock modules for psycopg2 and celery
sys.modules.setdefault("psycopg2", MagicMock())
sys.modules.setdefault("worker.celery_app", MagicMock())


from worker.budget_alerts import (  # noqa: E402
    WINDOW_SECONDS,
    _check_single_detector,
    _deterministic_finding_id,
    _get_budget_detectors_cached,
    check_budget_thresholds,
)

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _make_detector(
    detector_id="det-1",
    name="Budget $100/24h",
    threshold_usd=100.0,
    window="24h",
):
    return {
        "id": detector_id,
        "name": name,
        "threshold_usd": threshold_usd,
        "window": window,
    }


def _make_redis_mock(
    counter_value=0.0,
    ttl_value=-1,
    cooldown_exists=False,
    cached_detectors=None,
):
    """Create a mock Redis client with configurable behavior."""
    mock = MagicMock()
    mock.incrbyfloat.return_value = counter_value
    mock.ttl.return_value = ttl_value
    mock.exists.return_value = cooldown_exists
    # SET NX returns True if key was set (no existing key), False otherwise
    mock.set.return_value = not cooldown_exists

    if cached_detectors is not None:
        mock.get.return_value = json.dumps(cached_detectors)
    else:
        mock.get.return_value = None

    return mock


# ---------------------------------------------------------------------------
# Tests: _deterministic_finding_id
# ---------------------------------------------------------------------------


class TestDeterministicFindingId:
    def test_same_inputs_produce_same_id(self):
        id1 = _deterministic_finding_id("proj-1", "det-1", "24h-1716883200")
        id2 = _deterministic_finding_id("proj-1", "det-1", "24h-1716883200")
        assert id1 == id2

    def test_different_inputs_produce_different_ids(self):
        id1 = _deterministic_finding_id("proj-1", "det-1", "24h-1716883200")
        id2 = _deterministic_finding_id("proj-1", "det-2", "24h-1716883200")
        assert id1 != id2

    def test_id_format_is_uuid_like(self):
        fid = _deterministic_finding_id("proj-1", "det-1", "24h-1716883200")
        parts = fid.split("-")
        assert len(parts) == 5
        assert len(parts[0]) == 8
        assert len(parts[1]) == 4
        assert len(parts[2]) == 4
        assert len(parts[3]) == 4
        assert len(parts[4]) == 12


# ---------------------------------------------------------------------------
# Tests: _check_single_detector
# ---------------------------------------------------------------------------


class TestCheckSingleDetector:
    def test_below_threshold_no_enqueue(self):
        """When spend is below threshold, no finding should be enqueued."""
        detector = _make_detector(threshold_usd=100.0)
        redis_mock = _make_redis_mock(counter_value=50.0, ttl_value=86000)

        _check_single_detector(redis_mock, "proj-1", detector, batch_cost=10.0)

        # INCRBYFLOAT should be called
        redis_mock.incrbyfloat.assert_called_once()
        # No BullMQ enqueue (hset/rpush not called)
        redis_mock.hset.assert_not_called()
        redis_mock.rpush.assert_not_called()

    def test_at_threshold_enqueues_finding(self):
        """When spend reaches threshold, a finding should be enqueued."""
        detector = _make_detector(threshold_usd=100.0)
        redis_mock = _make_redis_mock(
            counter_value=100.0,  # exactly at threshold
            ttl_value=86000,
            cooldown_exists=False,
        )

        _check_single_detector(redis_mock, "proj-1", detector, batch_cost=10.0)

        # Cooldown should be set (SET NX)
        redis_mock.set.assert_called_once()
        # BullMQ enqueue should happen
        redis_mock.hset.assert_called_once()
        redis_mock.rpush.assert_called_once()

    def test_above_threshold_enqueues_finding(self):
        """When spend exceeds threshold, a finding should be enqueued."""
        detector = _make_detector(threshold_usd=100.0)
        redis_mock = _make_redis_mock(
            counter_value=150.0,
            ttl_value=86000,
            cooldown_exists=False,
        )

        _check_single_detector(redis_mock, "proj-1", detector, batch_cost=50.0)

        redis_mock.set.assert_called_once()
        redis_mock.hset.assert_called_once()
        redis_mock.rpush.assert_called_once()

    def test_cooldown_suppresses_duplicate(self):
        """When cooldown key exists, no finding should be enqueued."""
        detector = _make_detector(threshold_usd=100.0)
        redis_mock = _make_redis_mock(
            counter_value=150.0,
            ttl_value=86000,
            cooldown_exists=True,  # cooldown active
        )

        _check_single_detector(redis_mock, "proj-1", detector, batch_cost=50.0)

        # SET NX returns False (key already exists), so no enqueue
        redis_mock.hset.assert_not_called()
        redis_mock.rpush.assert_not_called()

    def test_cooldown_key_includes_window_epoch(self):
        """Verify that the cooldown key includes the window epoch to avoid bleeding across windows."""
        detector = _make_detector(threshold_usd=100.0, window="24h")
        redis_mock = _make_redis_mock(
            counter_value=150.0,
            ttl_value=86000,
            cooldown_exists=False,
        )

        _check_single_detector(redis_mock, "proj-1", detector, batch_cost=50.0)

        redis_mock.set.assert_called_once()
        cooldown_key = redis_mock.set.call_args[0][0]
        # Should be formatted as: budget:alert:cooldown:proj-1:det-1:24h-<epoch>
        assert cooldown_key.startswith("budget:alert:cooldown:proj-1:det-1:24h-")

    def test_new_counter_sets_ttl(self):
        """When counter key has no TTL (new key), TTL should be set."""
        detector = _make_detector(threshold_usd=1000.0, window="24h")
        redis_mock = _make_redis_mock(
            counter_value=10.0,
            ttl_value=-1,  # no TTL set
        )

        _check_single_detector(redis_mock, "proj-1", detector, batch_cost=10.0)

        redis_mock.expire.assert_called_once()
        args = redis_mock.expire.call_args[0]
        assert args[1] == WINDOW_SECONDS["24h"]

    def test_rollout_migration_migrates_old_key_spend(self):
        """Verify that when a new counter is initialized (TTL=-1) and an old un-scoped key exists,
        its spend is migrated and the old key is deleted to prevent double counting.
        """
        detector = _make_detector(threshold_usd=100.0, window="24h")

        mock_redis = MagicMock()
        mock_redis.incrbyfloat.side_effect = [10.0, 35.0]
        mock_redis.ttl.return_value = -1
        mock_redis.get.return_value = b"25.0"
        mock_redis.delete.return_value = 1
        mock_redis.exists.return_value = False
        mock_redis.set.return_value = True

        _check_single_detector(mock_redis, "proj-1", detector, batch_cost=10.0)

        # Should fetch the old key
        mock_redis.get.assert_called_with("budget:project:proj-1:det-1:24h")
        # Should delete the old key atomically
        mock_redis.delete.assert_called_once_with("budget:project:proj-1:det-1:24h")
        # Should set the TTL
        mock_redis.expire.assert_called_once()

    def test_existing_counter_skips_ttl(self):
        """When counter key already has a TTL, don't reset it."""
        detector = _make_detector(threshold_usd=1000.0)
        redis_mock = _make_redis_mock(
            counter_value=10.0,
            ttl_value=50000,  # TTL already set
        )

        _check_single_detector(redis_mock, "proj-1", detector, batch_cost=10.0)

        redis_mock.expire.assert_not_called()

    def test_enqueued_job_contains_budget_alert_payload(self):
        """Verify the BullMQ job payload structure."""
        detector = _make_detector(
            detector_id="det-42",
            name="Budget Alert",
            threshold_usd=50.0,
            window="1h",
        )
        redis_mock = _make_redis_mock(
            counter_value=60.0,
            ttl_value=3000,
            cooldown_exists=False,
        )

        _check_single_detector(redis_mock, "proj-99", detector, batch_cost=15.0)

        # Check the BullMQ hset call
        hset_call = redis_mock.hset.call_args
        mapping = hset_call[1]["mapping"]
        job_data = json.loads(mapping["data"])

        assert job_data["projectId"] == "proj-99"
        assert "budgetAlert" in job_data

        alert = job_data["budgetAlert"]
        assert alert["detectorId"] == "det-42"
        assert alert["detectorName"] == "Budget Alert"
        assert "$60.00" in alert["summary"]
        assert alert["data"]["threshold_usd"] == 50.0
        assert alert["data"]["current_spend_usd"] == 60.0
        assert alert["data"]["window"] == "1h"


# ---------------------------------------------------------------------------
# Tests: _get_budget_detectors_cached
# ---------------------------------------------------------------------------


class TestGetBudgetDetectorsCached:
    def test_returns_cached_value(self):
        """When cache exists, return it without DB query."""
        detectors = [_make_detector()]
        redis_mock = _make_redis_mock(cached_detectors=detectors)

        result = _get_budget_detectors_cached(redis_mock, "proj-1")

        assert len(result) == 1
        assert result[0]["id"] == "det-1"
        redis_mock.get.assert_called_once_with("budget:detectors:proj-1")

    def test_cache_miss_queries_db(self):
        """When cache is empty, fetch from DB and cache the result."""
        redis_mock = _make_redis_mock(cached_detectors=None)

        with patch("worker.budget_alerts._fetch_budget_detectors") as mock_fetch:
            mock_fetch.return_value = [_make_detector()]
            result = _get_budget_detectors_cached(redis_mock, "proj-1")

        assert len(result) == 1
        mock_fetch.assert_called_once_with("proj-1")
        # Should cache the result
        redis_mock.set.assert_called()


# ---------------------------------------------------------------------------
# Tests: check_budget_thresholds (integration)
# ---------------------------------------------------------------------------


class TestCheckBudgetThresholds:
    @patch("worker.budget_alerts._get_redis")
    @patch("worker.budget_alerts._get_budget_detectors_cached")
    def test_zero_cost_is_noop(self, mock_cached, mock_redis):
        """Batch with zero cost should not touch Redis at all."""
        check_budget_thresholds("proj-1", batch_cost=0.0)
        mock_redis.assert_not_called()

    @patch("worker.budget_alerts._get_redis")
    @patch("worker.budget_alerts._get_budget_detectors_cached")
    def test_negative_cost_is_noop(self, mock_cached, mock_redis):
        """Negative cost (shouldn't happen) is safely ignored."""
        check_budget_thresholds("proj-1", batch_cost=-5.0)
        mock_redis.assert_not_called()

    @patch("worker.budget_alerts._get_redis")
    @patch("worker.budget_alerts._get_budget_detectors_cached")
    def test_no_detectors_is_noop(self, mock_cached, mock_redis):
        """When no budget detectors exist, skip processing."""
        mock_cached.return_value = []
        mock_redis.return_value = MagicMock()

        check_budget_thresholds("proj-1", batch_cost=10.0)

        # Should call _get_redis and cache lookup, but no INCRBYFLOAT
        mock_redis.return_value.incrbyfloat.assert_not_called()

    @patch("worker.budget_alerts._get_redis")
    @patch("worker.budget_alerts._get_budget_detectors_cached")
    @patch("worker.budget_alerts._check_single_detector")
    def test_calls_check_for_each_detector(self, mock_check, mock_cached, mock_redis):
        """Should call _check_single_detector for each budget detector."""
        det1 = _make_detector(detector_id="det-1")
        det2 = _make_detector(detector_id="det-2")
        mock_cached.return_value = [det1, det2]
        mock_redis.return_value = MagicMock()

        check_budget_thresholds("proj-1", batch_cost=10.0)

        assert mock_check.call_count == 2

    @patch("worker.budget_alerts._get_redis")
    @patch("worker.budget_alerts._get_budget_detectors_cached")
    @patch("worker.budget_alerts._check_single_detector")
    def test_one_detector_failure_doesnt_block_others(self, mock_check, mock_cached, mock_redis):
        """If one detector check fails, others should still be checked."""
        det1 = _make_detector(detector_id="det-1")
        det2 = _make_detector(detector_id="det-2")
        mock_cached.return_value = [det1, det2]
        mock_redis.return_value = MagicMock()

        # First detector raises, second succeeds
        mock_check.side_effect = [RuntimeError("boom"), None]

        # Should not raise
        check_budget_thresholds("proj-1", batch_cost=10.0)

        assert mock_check.call_count == 2

    @patch("worker.budget_alerts._get_redis")
    @patch("worker.budget_alerts._get_budget_detectors_cached")
    @patch("worker.budget_alerts._check_single_detector")
    def test_idempotency_key_prevents_duplicate_processing(
        self, mock_check, mock_cached, mock_redis
    ):
        """When an idempotency key is provided, duplicate calls should be skipped."""
        det = _make_detector(detector_id="det-1")
        mock_cached.return_value = [det]
        redis_mock = MagicMock()
        mock_redis.return_value = redis_mock

        # First call with idempotency key
        redis_mock.set.return_value = True  # NX set succeeds (new key)
        check_budget_thresholds("proj-1", batch_cost=10.0, idempotency_key="unique-s3-key")
        assert mock_check.call_count == 1

        mock_check.reset_mock()

        # Second call with the same idempotency key
        redis_mock.set.return_value = False  # NX set fails (already exists)
        check_budget_thresholds("proj-1", batch_cost=10.0, idempotency_key="unique-s3-key")
        assert mock_check.call_count == 0  # Should skip single detector checks
