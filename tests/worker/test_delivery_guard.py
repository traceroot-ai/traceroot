"""worker/delivery_guard.py: the per-attempt redelivery count and its limit."""

import json
import logging
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest

from shared.config import IngestSettings
from worker import delivery_guard
from worker.celery_app import app
from worker.delivery_guard import (
    TTL_SECONDS,
    RedeliveryLimitError,
    check_redelivery,
    clear_delivery,
    delivery_key,
)

# The bundled MinIO's expiry rules: how long a staged batch exists.
LIFECYCLE = Path(__file__).resolve().parents[2] / "docker" / "minio" / "lifecycle.json"


class RecordingRedis:
    def __init__(self):
        self.values: dict[str, int] = {}
        self.ttls: dict[str, int] = {}
        self.closed = False

    def delete(self, key):
        self.values.pop(key, None)

    def close(self):
        self.closed = True

    def pipeline(self):
        redis, ops = self, []

        class Pipe:
            def incr(self, key):
                ops.append(("incr", key))

            def expire(self, key, seconds):
                ops.append(("expire", key, seconds))

            def execute(self):
                out = []
                for op in ops:
                    if op[0] == "incr":
                        redis.values[op[1]] = redis.values.get(op[1], 0) + 1
                        out.append(redis.values[op[1]])
                    else:
                        redis.ttls[op[1]] = op[2]
                        out.append(True)
                return out

        return Pipe()


def request(*, redelivered=True, task_id="t-1", retries=0):
    return SimpleNamespace(id=task_id, retries=retries, delivery_info={"redelivered": redelivered})


def test_a_first_delivery_is_not_counted_and_touches_nothing():
    redis = MagicMock()
    assert check_redelivery(request(redelivered=False), "k", client=redis, limit=1) is False
    clear_delivery(request(redelivered=False), client=redis)
    assert redis.mock_calls == []


@pytest.mark.parametrize(
    "req",
    [
        SimpleNamespace(id=None, retries=0, delivery_info={"redelivered": True}),
        SimpleNamespace(id="t-1", retries=0, delivery_info=None),
    ],
)
def test_a_direct_call_or_a_request_without_delivery_info_is_not_counted(req):
    redis = MagicMock()
    assert check_redelivery(req, "k", client=redis, limit=1) is False
    assert redis.mock_calls == []


def test_a_redelivery_is_counted_under_its_attempt_with_an_expiry():
    redis = RecordingRedis()
    assert check_redelivery(request(retries=2), "k", client=redis, limit=5) is True
    k = delivery_key("t-1", 2)
    assert redis.values == {k: 1}
    assert redis.ttls == {k: TTL_SECONDS}


def test_the_count_outlives_the_visibility_timeout_and_the_staged_batch():
    """A count that expired first would let the batch loop again until it is deleted."""
    visibility = app.conf.broker_transport_options["visibility_timeout"]
    rules = json.loads(LIFECYCLE.read_text())["Rules"]
    days = {r["Filter"]["Prefix"]: r["Expiration"]["Days"] for r in rules}["events/ingest/"]
    assert visibility < TTL_SECONDS
    assert days * 24 * 3600 <= TTL_SECONDS


def test_deliveries_up_to_the_limit_run_and_the_next_is_refused(caplog):
    """limit=3: the first delivery and two redeliveries run; the third redelivery is refused."""
    redis = RecordingRedis()
    for _ in range(2):
        assert check_redelivery(request(), "events/ingest/p/b.pb", client=redis, limit=3)
    with (
        caplog.at_level(logging.ERROR, logger="worker.delivery_guard"),
        pytest.raises(RedeliveryLimitError, match="delivery 4 of an attempt"),
    ):
        check_redelivery(request(), "events/ingest/p/b.pb", client=redis, limit=3)
    assert "Batch events/ingest/p/b.pb reached delivery 4" in caplog.text


def test_the_limit_defaults_to_the_setting(monkeypatch):
    from shared.config import settings

    monkeypatch.setattr(settings.ingest, "max_deliveries", 1)
    with pytest.raises(RedeliveryLimitError):
        check_redelivery(request(), "k", client=RecordingRedis())


def test_a_refusal_is_counted(monkeypatch):
    counter = MagicMock()
    monkeypatch.setattr(delivery_guard, "_refused_counter", counter)
    with pytest.raises(RedeliveryLimitError):
        check_redelivery(request(), "k", client=RecordingRedis(), limit=1)
    counter.add.assert_called_once_with(1, {})


def test_a_redis_error_lets_the_delivery_run(caplog):
    broken = MagicMock()
    broken.pipeline.return_value.execute.side_effect = ConnectionError("down")
    with caplog.at_level(logging.WARNING, logger="worker.delivery_guard"):
        assert check_redelivery(request(), "k", client=broken, limit=1) is False
    assert "Could not count the redeliveries of k" in caplog.text


def test_clearing_drops_only_this_attempts_count():
    redis = RecordingRedis()
    check_redelivery(request(retries=0), "k", client=redis, limit=5)
    check_redelivery(request(retries=1), "k", client=redis, limit=5)
    clear_delivery(request(retries=0), client=redis)
    assert redis.values == {delivery_key("t-1", 1): 1}


def test_clearing_is_best_effort():
    broken = MagicMock()
    broken.delete.side_effect = ConnectionError("down")
    clear_delivery(request(), client=broken)  # does not raise
    broken.delete.assert_called_once()


def test_a_client_it_opens_itself_is_closed(monkeypatch):
    opened: list[tuple[dict, RecordingRedis]] = []

    def from_url(url, **kwargs):
        opened.append((kwargs, RecordingRedis()))
        return opened[-1][1]

    monkeypatch.setattr("redis.Redis.from_url", from_url)
    check_redelivery(request(), "k", limit=5)
    clear_delivery(request())
    assert len(opened) == 2 and all(client.closed for _, client in opened)
    assert opened[0][0] == {"socket_connect_timeout": 2, "socket_timeout": 2}


class TestSetting:
    def test_default_is_three(self, monkeypatch):
        monkeypatch.delenv("INGEST_MAX_DELIVERIES", raising=False)
        assert IngestSettings().max_deliveries == 3

    def test_env_override(self, monkeypatch):
        monkeypatch.setenv("INGEST_MAX_DELIVERIES", "5")
        assert IngestSettings().max_deliveries == 5

    @pytest.mark.parametrize("value", ["0", "-1", "three"])
    def test_invalid_values_are_rejected(self, monkeypatch, value):
        monkeypatch.setenv("INGEST_MAX_DELIVERIES", value)
        with pytest.raises(ValueError):
            IngestSettings()
