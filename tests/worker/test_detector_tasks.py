"""Unit tests for the exactly-once detector enqueue path (Redis lock + BullMQ)."""

import json
import threading
from unittest.mock import MagicMock

import pytest

import worker.detector_tasks as dt

PROJECT = "proj-1"
TRACE = "aa" * 16


class FakeRedis:
    """Dict-backed Redis stand-in with atomic SET NX and the compare-and-delete
    Lua script used for token-checked lock release."""

    def __init__(self):
        self.store: dict[str, bytes] = {}
        self._mutex = threading.Lock()

    def set(self, key, value, nx=False, ex=None):
        if isinstance(value, str):
            value = value.encode()
        with self._mutex:
            if nx and key in self.store:
                return None
            self.store[key] = value
            return True

    def get(self, key):
        with self._mutex:
            return self.store.get(key)

    def eval(self, script, numkeys, key, arg):
        if isinstance(arg, str):
            arg = arg.encode()
        with self._mutex:
            if self.store.get(key) == arg:
                del self.store[key]
                return 1
            return 0


@pytest.fixture()
def fake_redis(monkeypatch):
    r = FakeRedis()
    monkeypatch.setattr(dt, "_get_redis", lambda: r)
    return r


@pytest.fixture()
def mock_add_job(monkeypatch):
    mock = MagicMock()
    monkeypatch.setattr(dt, "_add_bullmq_job", mock)
    return mock


def _detector(detector_id, sample_rate=100, conditions=None):
    return {"id": detector_id, "sample_rate": sample_rate, "conditions": conditions or []}


def _patch_detectors(monkeypatch, detectors):
    monkeypatch.setattr(dt, "_get_active_detectors", lambda project_id: detectors)


def _patch_summaries(monkeypatch, summaries):
    monkeypatch.setattr(dt, "_get_trace_summaries", lambda project_id, trace_ids: summaries)


def _lock_state(fake_redis, project_id=PROJECT, trace_id=TRACE):
    raw = fake_redis.store.get(dt._lock_key(project_id, trace_id))
    return json.loads(raw) if raw is not None else None


# ── Primary path: root-bearing batch ────────────────────────────────────


class TestPrimaryEnqueue:
    def test_root_trace_enqueues_one_job_and_marks_pending(
        self, fake_redis, mock_add_job, monkeypatch
    ):
        """Conditions + deterministic sampling select detectors; one delayed job is added."""
        _patch_detectors(
            monkeypatch,
            [
                _detector("d-pass", sample_rate=100),
                _detector("d-sampled-out", sample_rate=0),
                _detector(
                    "d-cond-fail",
                    sample_rate=100,
                    conditions=[{"field": "environment", "op": "=", "value": "production"}],
                ),
            ],
        )
        _patch_summaries(monkeypatch, {TRACE: {"environment": "staging"}})

        dt.enqueue_detector_runs(PROJECT, [TRACE], {TRACE})

        mock_add_job.assert_called_once_with(
            f"{PROJECT}--{TRACE}",
            {
                "traceId": TRACE,
                "detectorIds": ["d-pass"],
                "projectId": PROJECT,
            },
        )
        state = _lock_state(fake_redis)
        assert state["state"] == "pending"
        assert state["detector_ids"] == ["d-pass"]
        assert state["token"]

    def test_non_root_batch_enqueues_nothing(self, fake_redis, mock_add_job, monkeypatch):
        """GROUND TRUTH (exactly-once): only the root-bearing batch enqueues. A
        later batch whose trace is NOT in traces_with_root claims nothing and
        adds no job, so a multi-batch trace is never enqueued more than once."""
        _patch_detectors(monkeypatch, [_detector("d1")])
        _patch_summaries(monkeypatch, {})

        # TRACE is in the batch but NOT root-bearing this batch.
        dt.enqueue_detector_runs(PROJECT, [TRACE], set())

        mock_add_job.assert_not_called()
        assert _lock_state(fake_redis) is None

    def test_duplicate_root_delivery_noops(self, fake_redis, mock_add_job, monkeypatch):
        """Second root delivery loses the NX claim — exactly one job ever added."""
        _patch_detectors(monkeypatch, [_detector("d1")])
        _patch_summaries(monkeypatch, {})

        dt.enqueue_detector_runs(PROJECT, [TRACE], {TRACE})
        first_value = fake_redis.store[dt._lock_key(PROJECT, TRACE)]

        dt.enqueue_detector_runs(PROJECT, [TRACE], {TRACE})

        assert mock_add_job.call_count == 1
        assert fake_redis.store[dt._lock_key(PROJECT, TRACE)] == first_value

    def test_sampled_out_is_sticky(self, fake_redis, mock_add_job, monkeypatch):
        """A no-sample decision is recorded and a replay must not re-roll it."""
        _patch_detectors(monkeypatch, [_detector("d1", sample_rate=0)])
        _patch_summaries(monkeypatch, {})

        dt.enqueue_detector_runs(PROJECT, [TRACE], {TRACE})
        assert _lock_state(fake_redis)["state"] == "sampled_out"
        first_value = fake_redis.store[dt._lock_key(PROJECT, TRACE)]

        dt.enqueue_detector_runs(PROJECT, [TRACE], {TRACE})

        mock_add_job.assert_not_called()
        assert fake_redis.store[dt._lock_key(PROJECT, TRACE)] == first_value

    def test_no_active_detectors_marks_sampled_out(self, fake_redis, mock_add_job, monkeypatch):
        _patch_detectors(monkeypatch, [])

        dt.enqueue_detector_runs(PROJECT, [TRACE], {TRACE})

        mock_add_job.assert_not_called()
        assert _lock_state(fake_redis)["state"] == "sampled_out"

    def test_bad_trace_does_not_drop_rest_of_batch(self, fake_redis, mock_add_job, monkeypatch):
        """A malformed condition only drops the offending trace."""
        other = "bb" * 16
        _patch_detectors(
            monkeypatch,
            [_detector("d1", conditions=[{"field": "cost", "op": ">", "value": "not-a-number"}])],
        )
        _patch_summaries(monkeypatch, {TRACE: {"cost": 5}, other: {}})

        dt.enqueue_detector_runs(PROJECT, [TRACE, other], {TRACE, other})

        # TRACE raises in float(); `other` has cost missing -> condition False -> sampled_out.
        assert mock_add_job.call_count == 0
        assert _lock_state(fake_redis, trace_id=other)["state"] == "sampled_out"

    def test_concurrent_claims_enqueue_exactly_once(self, fake_redis, monkeypatch):
        added = []
        monkeypatch.setattr(dt, "_add_bullmq_job", lambda job_id, data: added.append(job_id))
        _patch_detectors(monkeypatch, [_detector("d1")])
        _patch_summaries(monkeypatch, {})

        threads = [
            threading.Thread(target=dt.enqueue_detector_runs, args=(PROJECT, [TRACE], {TRACE}))
            for _ in range(8)
        ]
        for t in threads:
            t.start()
        for t in threads:
            t.join()

        assert added == [f"{PROJECT}--{TRACE}"]
        assert _lock_state(fake_redis)["state"] == "pending"


# ── Failure release (token-checked) ─────────────────────────────────────


class TestFailureRelease:
    def test_enqueue_failure_releases_lock_and_allows_reclaim(
        self, fake_redis, mock_add_job, monkeypatch
    ):
        _patch_detectors(monkeypatch, [_detector("d1")])
        _patch_summaries(monkeypatch, {})

        mock_add_job.side_effect = RuntimeError("redis down")
        dt.enqueue_detector_runs(PROJECT, [TRACE], {TRACE})
        assert dt._lock_key(PROJECT, TRACE) not in fake_redis.store

        mock_add_job.side_effect = None
        dt.enqueue_detector_runs(PROJECT, [TRACE], {TRACE})
        assert mock_add_job.call_count == 2
        assert _lock_state(fake_redis)["state"] == "pending"

    def test_failure_release_refuses_foreign_lock_value(self, fake_redis, monkeypatch):
        """If another actor replaced the lock mid-attempt, the failing attempt
        must not delete the successor's state."""
        _patch_detectors(monkeypatch, [_detector("d1")])
        _patch_summaries(monkeypatch, {})
        key = dt._lock_key(PROJECT, TRACE)
        foreign = json.dumps({"state": "pending", "detector_ids": ["other"], "token": "zzz"})

        def hijack_then_fail(job_id, data):
            fake_redis.store[key] = foreign.encode()
            raise RuntimeError("boom")

        monkeypatch.setattr(dt, "_add_bullmq_job", hijack_then_fail)
        dt.enqueue_detector_runs(PROJECT, [TRACE], {TRACE})

        assert fake_redis.store[key] == foreign.encode()

    def test_release_helper_only_deletes_matching_value(self):
        r = FakeRedis()
        r.set("k", "value-a")
        dt._release_lock_if_value(r, "k", "value-b")
        assert r.store["k"] == b"value-a"
        dt._release_lock_if_value(r, "k", "value-a")
        assert "k" not in r.store


# ── Deterministic sampling ──────────────────────────────────────────────


class TestDeterministicSampling:
    def test_same_pair_always_same_decision(self):
        first = dt._sample_passes(TRACE, "det-1", 50)
        assert all(dt._sample_passes(TRACE, "det-1", 50) == first for _ in range(20))

    def test_rate_extremes(self):
        assert dt._sample_passes(TRACE, "det-1", 100) is True
        assert dt._sample_passes(TRACE, "det-1", 0) is False

    def test_distribution_close_to_rate(self):
        n = 2000
        hits = sum(dt._sample_passes(f"trace-{i}", "det-x", 30) for i in range(n))
        assert 0.26 < hits / n < 0.34


# ── Re-eval path: late batches ──────────────────────────────────────────


# ── BullMQ helper ───────────────────────────────────────────────────────


class TestAddBullmqJob:
    def test_adds_delayed_job_with_dedup_id_and_closes(self, monkeypatch):
        queues = []

        class FakeQueue:
            def __init__(self, name, opts=None):
                self.name = name
                self.opts = opts
                self.added = []
                self.closed = False
                queues.append(self)

            async def add(self, name, data, opts):
                self.added.append((name, data, opts))

            async def close(self):
                self.closed = True

        monkeypatch.setattr("bullmq.Queue", FakeQueue)

        data = {"traceId": TRACE, "detectorIds": ["d1"], "projectId": PROJECT}
        dt._add_bullmq_job(f"{PROJECT}--{TRACE}", data)

        assert len(queues) == 1
        queue = queues[0]
        assert queue.name == dt.DETECTOR_RUN_QUEUE
        assert "connection" in queue.opts
        assert queue.closed is True
        assert queue.added == [
            (
                "detect",
                data,
                {
                    "jobId": f"{PROJECT}--{TRACE}",
                    "delay": 60000,
                    "attempts": 3,
                    "removeOnComplete": 100,
                    "removeOnFail": 50,
                },
            )
        ]


# ── Top-level guard ─────────────────────────────────────────────────────


class TestTopLevelGuard:
    def test_empty_trace_ids_noop(self, monkeypatch):
        monkeypatch.setattr(
            dt, "_get_redis", MagicMock(side_effect=AssertionError("should not connect"))
        )
        dt.enqueue_detector_runs(PROJECT, [], set())

    def test_never_raises(self, monkeypatch):
        monkeypatch.setattr(dt, "_get_redis", MagicMock(side_effect=RuntimeError("redis down")))
        dt.enqueue_detector_runs(PROJECT, [TRACE], {TRACE})
