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
    monkeypatch.setattr(
        dt, "_get_trace_summaries", lambda project_id, trace_ids, **kwargs: summaries
    )


def _lock_state(fake_redis, project_id=PROJECT, trace_id=TRACE):
    raw = fake_redis.store.get(dt._lock_key(project_id, trace_id))
    return json.loads(raw) if raw is not None else None


# ── Primary path: root-bearing batch ────────────────────────────────────


class TestPrimaryEnqueue:
    def test_root_trace_enqueues_one_job_and_marks_pending(
        self, fake_redis, mock_add_job, monkeypatch
    ):
        """Deterministic sampling selects detectors; one delayed job is added.

        A detector whose condition the root batch does not meet is still enqueued:
        conditions are judged later, on the settled trace (#3065)."""
        _patch_detectors(
            monkeypatch,
            [
                _detector("d-pass", sample_rate=100),
                _detector("d-sampled-out", sample_rate=0),
                _detector(
                    "d-cond-not-yet-met",
                    sample_rate=100,
                    conditions=[{"field": "environment", "op": "=", "value": "production"}],
                ),
            ],
        )
        _patch_summaries(monkeypatch, {TRACE: {"environment": "staging"}})

        dt.enqueue_detector_runs(PROJECT, {TRACE})

        mock_add_job.assert_called_once_with(
            f"{PROJECT}--{TRACE}",
            {
                "traceId": TRACE,
                "detectorIds": ["d-pass", "d-cond-not-yet-met"],
                "projectId": PROJECT,
            },
        )
        state = _lock_state(fake_redis)
        assert state["state"] == "pending"
        assert state["detector_ids"] == ["d-pass", "d-cond-not-yet-met"]
        assert state["token"]

    def test_non_root_batch_enqueues_nothing(self, fake_redis, mock_add_job, monkeypatch):
        """GROUND TRUTH (exactly-once): only the root-bearing batch enqueues. A
        later batch whose trace is NOT in traces_with_root claims nothing and
        adds no job, so a multi-batch trace is never enqueued more than once."""
        _patch_detectors(monkeypatch, [_detector("d1")])
        _patch_summaries(monkeypatch, {})

        # No root span arrived in this batch → nothing to enqueue.
        dt.enqueue_detector_runs(PROJECT, set())

        mock_add_job.assert_not_called()
        assert _lock_state(fake_redis) is None

    def test_duplicate_root_delivery_noops(self, fake_redis, mock_add_job, monkeypatch):
        """Second root delivery loses the NX claim — exactly one job ever added."""
        _patch_detectors(monkeypatch, [_detector("d1")])
        _patch_summaries(monkeypatch, {TRACE: {}})

        dt.enqueue_detector_runs(PROJECT, {TRACE})
        first_value = fake_redis.store[dt._lock_key(PROJECT, TRACE)]

        dt.enqueue_detector_runs(PROJECT, {TRACE})

        assert mock_add_job.call_count == 1
        assert fake_redis.store[dt._lock_key(PROJECT, TRACE)] == first_value

    def test_sampled_out_is_sticky(self, fake_redis, mock_add_job, monkeypatch):
        """A no-sample decision is recorded and a replay must not re-roll it."""
        _patch_detectors(monkeypatch, [_detector("d1", sample_rate=0)])
        _patch_summaries(monkeypatch, {TRACE: {}})

        dt.enqueue_detector_runs(PROJECT, {TRACE})
        assert _lock_state(fake_redis)["state"] == "sampled_out"
        first_value = fake_redis.store[dt._lock_key(PROJECT, TRACE)]

        dt.enqueue_detector_runs(PROJECT, {TRACE})

        mock_add_job.assert_not_called()
        assert fake_redis.store[dt._lock_key(PROJECT, TRACE)] == first_value

    def test_no_active_detectors_marks_sampled_out(self, fake_redis, mock_add_job, monkeypatch):
        _patch_detectors(monkeypatch, [])

        dt.enqueue_detector_runs(PROJECT, {TRACE})

        mock_add_job.assert_not_called()
        assert _lock_state(fake_redis)["state"] == "sampled_out"

    def test_bad_trace_does_not_drop_rest_of_batch(self, fake_redis, mock_add_job, monkeypatch):
        """A per-trace enqueue failure only drops the offending trace."""
        other = "bb" * 16
        _patch_detectors(monkeypatch, [_detector("d1")])
        _patch_summaries(monkeypatch, {TRACE: {}, other: {}})

        def fail_for_trace(job_id, data):
            if data["traceId"] == TRACE:
                raise RuntimeError("boom")

        mock_add_job.side_effect = fail_for_trace

        dt.enqueue_detector_runs(PROJECT, {TRACE, other})

        assert {c.args[1]["traceId"] for c in mock_add_job.call_args_list} == {TRACE, other}
        assert _lock_state(fake_redis, trace_id=TRACE) is None  # released for a retry
        assert _lock_state(fake_redis, trace_id=other)["state"] == "pending"

    def test_concurrent_claims_enqueue_exactly_once(self, fake_redis, monkeypatch):
        added = []
        monkeypatch.setattr(dt, "_add_bullmq_job", lambda job_id, data: added.append(job_id))
        _patch_detectors(monkeypatch, [_detector("d1")])
        _patch_summaries(monkeypatch, {TRACE: {}})

        threads = [
            threading.Thread(target=dt.enqueue_detector_runs, args=(PROJECT, {TRACE}))
            for _ in range(8)
        ]
        for t in threads:
            t.start()
        for t in threads:
            t.join()

        assert added == [f"{PROJECT}--{TRACE}"]
        assert _lock_state(fake_redis)["state"] == "pending"


# ── Trigger conditions judge the settled trace (#3065) ──────────────────


COST_OVER_HALF = [{"field": "cost", "op": ">", "value": 0.50}]


class TestTriggerConditionsOnSettledTrace:
    """The root span can be exported in an earlier batch than the spans carrying a
    trace's cost and errors. Conditions judged on that first batch dropped traces
    that met them once complete, and the sticky lock kept them dropped."""

    def test_multi_batch_trace_that_meets_its_condition_runs(
        self, fake_redis, mock_add_job, monkeypatch
    ):
        """The scenario from #3065, driven through both halves of the path."""
        _patch_detectors(monkeypatch, [_detector("d-cost", conditions=COST_OVER_HALF)])

        # Batch 1: only the root span is stored, so the trace costs nothing yet.
        _patch_summaries(monkeypatch, {TRACE: {"cost": 0.0, "errors": 0}})
        dt.enqueue_detector_runs(PROJECT, {TRACE})

        mock_add_job.assert_called_once()
        assert mock_add_job.call_args.args[1]["detectorIds"] == ["d-cost"]
        assert _lock_state(fake_redis)["state"] == "pending"

        # Batch 2 lands with the expensive child spans; the worker then sees the
        # trace quiet and asks which detectors trigger on the settled trace.
        _patch_summaries(monkeypatch, {TRACE: {"cost": 1.50, "errors": 1}})
        assert dt.select_triggered_detectors(PROJECT, TRACE, ["d-cost"]) == ["d-cost"]

    def test_child_span_tag_excludes_a_trace_after_the_root_enqueues(
        self, fake_redis, mock_add_job, monkeypatch
    ):
        """A health-check tag can arrive on a child span after the root batch."""
        exclude_healthchecks = [
            {"field": "metadata", "key": "traffic_type", "op": "!=", "value": "healthcheck"}
        ]
        _patch_detectors(
            monkeypatch, [_detector("d-no-healthchecks", conditions=exclude_healthchecks)]
        )

        _patch_summaries(monkeypatch, {TRACE: {"metadata": {}}})
        dt.enqueue_detector_runs(PROJECT, {TRACE})
        mock_add_job.assert_called_once()
        assert mock_add_job.call_args.args[1]["detectorIds"] == ["d-no-healthchecks"]
        assert _lock_state(fake_redis)["state"] == "pending"

        settled_metadata = dt._merge_metadata_values(None, [{}, {"traffic_type": "healthcheck"}])
        _patch_summaries(monkeypatch, {TRACE: {"metadata": settled_metadata}})
        assert dt.select_triggered_detectors(PROJECT, TRACE, ["d-no-healthchecks"]) == []

        _patch_summaries(monkeypatch, {TRACE: {"metadata": {}}})
        assert dt.select_triggered_detectors(PROJECT, TRACE, ["d-no-healthchecks"]) == [
            "d-no-healthchecks"
        ]

    def test_settled_trace_that_misses_its_condition_runs_nothing(self, monkeypatch):
        _patch_detectors(monkeypatch, [_detector("d-cost", conditions=COST_OVER_HALF)])
        _patch_summaries(monkeypatch, {TRACE: {"cost": 0.10}})

        assert dt.select_triggered_detectors(PROJECT, TRACE, ["d-cost"]) == []

    def test_condition_met_at_root_but_not_once_settled_runs_nothing(self, monkeypatch):
        """The reverse failure: ``errors = 0`` holds on the root batch alone, but a
        later batch carries an error. Judging at enqueue ran the detector anyway."""
        no_errors = [{"field": "errors", "op": "=", "value": 0}]
        _patch_detectors(monkeypatch, [_detector("d-clean", conditions=no_errors)])
        _patch_summaries(monkeypatch, {TRACE: {"errors": 1}})

        assert dt.select_triggered_detectors(PROJECT, TRACE, ["d-clean"]) == []

    def test_only_detectors_still_active_are_selected_in_job_order(self, monkeypatch):
        """A detector disabled or deleted since enqueue drops out; the rest keep the
        order the job carried them in."""
        _patch_detectors(monkeypatch, [_detector("d-a"), _detector("d-b")])
        _patch_summaries(monkeypatch, {TRACE: {}})

        selected = dt.select_triggered_detectors(PROJECT, TRACE, ["d-b", "d-gone", "d-a"])

        assert selected == ["d-b", "d-a"]

    def test_trace_without_a_customer_summary_selects_nothing(self, monkeypatch):
        _patch_detectors(monkeypatch, [_detector("d1")])
        _patch_summaries(monkeypatch, {})

        assert dt.select_triggered_detectors(PROJECT, TRACE, ["d1"]) == []

    def test_trace_metadata_is_read_only_for_a_metadata_condition(self, monkeypatch):
        """The traces-table read is gated on a metadata condition at enqueue; the
        settled check must gate it the same way, on the candidate detectors only."""
        flags = []

        def summaries(project_id, trace_ids, *, include_trace_metadata=True):
            flags.append(include_trace_metadata)
            return {TRACE: {"metadata": {"tier": ["gold"]}}}

        on_metadata = [{"field": "metadata", "key": "tier", "op": "=", "value": "gold"}]
        _patch_detectors(
            monkeypatch,
            [_detector("d-plain"), _detector("d-meta", conditions=on_metadata)],
        )
        monkeypatch.setattr(dt, "_get_trace_summaries", summaries)

        assert dt.select_triggered_detectors(PROJECT, TRACE, ["d-plain"]) == ["d-plain"]
        assert dt.select_triggered_detectors(PROJECT, TRACE, ["d-meta"]) == ["d-meta"]
        assert flags == [False, True]

    def test_enqueue_never_reads_trace_metadata(self, fake_redis, mock_add_job, monkeypatch):
        """Enqueue no longer judges conditions, so even a metadata condition must not
        cost it the traces-table read; the settled check makes that read instead."""
        flags = []

        def summaries(project_id, trace_ids, *, include_trace_metadata=True):
            flags.append(include_trace_metadata)
            return {TRACE: {}}

        on_metadata = [{"field": "metadata", "key": "tier", "op": "=", "value": "gold"}]
        _patch_detectors(monkeypatch, [_detector("d-meta", conditions=on_metadata)])
        monkeypatch.setattr(dt, "_get_trace_summaries", summaries)

        dt.enqueue_detector_runs(PROJECT, {TRACE})

        assert flags == [False]
        mock_add_job.assert_called_once()

    def test_empty_detector_list_reads_nothing(self, monkeypatch):
        boom = MagicMock(side_effect=AssertionError("must not be called"))
        monkeypatch.setattr(dt, "_get_active_detectors", boom)

        assert dt.select_triggered_detectors(PROJECT, TRACE, []) == []

    def test_infrastructure_failure_raises_so_the_worker_retries(self, monkeypatch):
        """An outage must not read as "no detector triggered", which would silently
        drop the trace the way #3065 did."""
        monkeypatch.setattr(
            dt,
            "_get_active_detectors",
            MagicMock(side_effect=RuntimeError("postgres down")),
        )

        with pytest.raises(RuntimeError):
            dt.select_triggered_detectors(PROJECT, TRACE, ["d1"])


# ── Failure release (token-checked) ─────────────────────────────────────


class TestFailureRelease:
    def test_enqueue_failure_releases_lock_and_allows_reclaim(
        self, fake_redis, mock_add_job, monkeypatch
    ):
        _patch_detectors(monkeypatch, [_detector("d1")])
        _patch_summaries(monkeypatch, {TRACE: {}})

        mock_add_job.side_effect = RuntimeError("redis down")
        dt.enqueue_detector_runs(PROJECT, {TRACE})
        assert dt._lock_key(PROJECT, TRACE) not in fake_redis.store

        mock_add_job.side_effect = None
        dt.enqueue_detector_runs(PROJECT, {TRACE})
        assert mock_add_job.call_count == 2
        assert _lock_state(fake_redis)["state"] == "pending"

    def test_failure_release_refuses_foreign_lock_value(self, fake_redis, monkeypatch):
        """If another actor replaced the lock mid-attempt, the failing attempt
        must not delete the successor's state."""
        _patch_detectors(monkeypatch, [_detector("d1")])
        _patch_summaries(monkeypatch, {TRACE: {}})
        key = dt._lock_key(PROJECT, TRACE)
        foreign = json.dumps({"state": "pending", "detector_ids": ["other"], "token": "zzz"})

        def hijack_then_fail(job_id, data):
            fake_redis.store[key] = foreign.encode()
            raise RuntimeError("boom")

        monkeypatch.setattr(dt, "_add_bullmq_job", hijack_then_fail)
        dt.enqueue_detector_runs(PROJECT, {TRACE})

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

    def test_none_rate_never_samples(self):
        assert dt._sample_passes(TRACE, "det-1", None) is False

    def test_out_of_range_rate_is_clamped(self):
        # Negative clamps to 0 (never), above 100 clamps to 100 (always).
        assert dt._sample_passes(TRACE, "det-1", -5) is False
        assert dt._sample_passes(TRACE, "det-1", 150) is True

    def test_distribution_close_to_rate(self):
        n = 2000
        hits = sum(dt._sample_passes(f"trace-{i}", "det-x", 30) for i in range(n))
        assert 0.26 < hits / n < 0.34


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
                    "attempts": 5,
                    "backoff": {"type": "exponential", "delay": 5000},
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
        dt.enqueue_detector_runs(PROJECT, set())

    def test_never_raises(self, monkeypatch):
        monkeypatch.setattr(dt, "_get_redis", MagicMock(side_effect=RuntimeError("redis down")))
        dt.enqueue_detector_runs(PROJECT, {TRACE})


# ── _eval_condition: environment field semantics ────────────────────────


class TestEvalConditionEnvironment:
    """Pins the missing-field semantics (`actual is None` -> `op == "!="`) and
    its interaction with a populated `environment` value, so a fix at the
    insert layer that makes `environment` non-NULL cannot silently change how
    a genuinely absent value is handled."""

    def test_missing_field_equals_never_matches(self):
        assert dt._eval_condition({}, {"field": "environment", "op": "=", "value": "prod"}) is (
            False
        )

    def test_missing_field_not_equals_always_matches(self):
        assert (
            dt._eval_condition({}, {"field": "environment", "op": "!=", "value": "staging"}) is True
        )

    def test_populated_field_equals_matching_value(self):
        summary = {"environment": "production"}
        assert (
            dt._eval_condition(summary, {"field": "environment", "op": "=", "value": "production"})
            is True
        )

    def test_populated_field_equals_non_matching_value(self):
        summary = {"environment": "production"}
        assert (
            dt._eval_condition(summary, {"field": "environment", "op": "=", "value": "staging"})
            is False
        )

    def test_populated_field_not_equals_excluded_value(self):
        """A trace whose environment IS the excluded value must not fire."""
        summary = {"environment": "staging"}
        assert (
            dt._eval_condition(summary, {"field": "environment", "op": "!=", "value": "staging"})
            is False
        )

    def test_populated_field_not_equals_other_value(self):
        """A trace outside the excluded value fires."""
        summary = {"environment": "production"}
        assert (
            dt._eval_condition(summary, {"field": "environment", "op": "!=", "value": "staging"})
            is True
        )


# ── Evaluation traces are skipped by detectors ──────────────────────────


class TestEvaluationTraceSkip:
    """The real assertion for the feature: an offline-evaluation trace must not enqueue
    a BullMQ job. These drive ``enqueue_detector_runs`` end to end rather than calling
    ``_detector_runs_on_trace`` in isolation — removing the guard from the comprehension
    in ``_claim_and_enqueue`` has to make them fail, otherwise they prove nothing.
    """

    def test_evaluation_trace_enqueues_nothing_and_is_sticky(
        self, fake_redis, mock_add_job, monkeypatch
    ):
        """No job, and the decision is recorded so a replay cannot re-roll it."""
        _patch_detectors(monkeypatch, [_detector("d1", sample_rate=100)])
        _patch_summaries(monkeypatch, {TRACE: {"environment": None, "is_evaluation": True}})

        dt.enqueue_detector_runs(PROJECT, {TRACE})

        mock_add_job.assert_not_called()
        assert _lock_state(fake_redis)["state"] == "sampled_out"

    def test_production_trace_still_enqueues(self, fake_redis, mock_add_job, monkeypatch):
        """Control: the same detector on a non-evaluation trace DOES enqueue, so the
        test above is attributable to the evaluation flag and not to a broken fixture."""
        _patch_detectors(monkeypatch, [_detector("d1", sample_rate=100)])
        _patch_summaries(
            monkeypatch, {TRACE: {"environment": "production", "is_evaluation": False}}
        )

        dt.enqueue_detector_runs(PROJECT, {TRACE})

        mock_add_job.assert_called_once()
        assert _lock_state(fake_redis)["state"] == "pending"

    def test_customer_environment_named_evaluation_still_enqueues(
        self, fake_redis, mock_add_job, monkeypatch
    ):
        """REGRESSION: ``environment`` is user-controlled free text. A team that names a
        real deployment "evaluation" must keep its detectors — the skip keys off the root
        span's KIND, never off this string."""
        _patch_detectors(monkeypatch, [_detector("d1", sample_rate=100)])
        _patch_summaries(
            monkeypatch, {TRACE: {"environment": "evaluation", "is_evaluation": False}}
        )

        dt.enqueue_detector_runs(PROJECT, {TRACE})

        mock_add_job.assert_called_once()
        assert _lock_state(fake_redis)["state"] == "pending"

    def test_opted_in_detector_runs_on_evaluation_trace(
        self, fake_redis, mock_add_job, monkeypatch
    ):
        detector = _detector("d1", sample_rate=100)
        detector["run_on_evaluation"] = True
        _patch_detectors(monkeypatch, [detector])
        _patch_summaries(monkeypatch, {TRACE: {"is_evaluation": True}})

        dt.enqueue_detector_runs(PROJECT, {TRACE})

        mock_add_job.assert_called_once()

    def test_mixed_batch_skips_only_the_evaluation_trace(
        self, fake_redis, mock_add_job, monkeypatch
    ):
        """One eval trace in a batch must not suppress its neighbours."""
        prod_trace = "bb" * 16
        _patch_detectors(monkeypatch, [_detector("d1", sample_rate=100)])
        _patch_summaries(
            monkeypatch,
            {
                TRACE: {"is_evaluation": True},
                prod_trace: {"is_evaluation": False},
            },
        )

        dt.enqueue_detector_runs(PROJECT, {TRACE, prod_trace})

        assert mock_add_job.call_count == 1
        assert mock_add_job.call_args.args[1]["traceId"] == prod_trace


# ── Internal traces are never detector targets ──────────────────────────


class TestInternalTraceSkip:
    """The summary query is scoped to ``source = 'user'``, so a trace with no summary
    has no customer spans. ``enqueue_detector_runs`` must treat that as "not a
    target" — a detector with no conditions passes ``_passes_trigger`` on an empty
    summary, so without this gate an internal self-trace would still be enqueued.
    """

    def test_summary_less_trace_is_not_enqueued_even_without_conditions(
        self, fake_redis, mock_add_job, monkeypatch
    ):
        _patch_detectors(monkeypatch, [_detector("d1", sample_rate=100, conditions=[])])
        _patch_summaries(monkeypatch, {})

        dt.enqueue_detector_runs(PROJECT, {TRACE})

        mock_add_job.assert_not_called()
        assert _lock_state(fake_redis) is None

    def test_trace_with_summary_still_enqueues(self, fake_redis, mock_add_job, monkeypatch):
        """Control: the same detector on a trace the scoped query did return."""
        _patch_detectors(monkeypatch, [_detector("d1", sample_rate=100, conditions=[])])
        _patch_summaries(monkeypatch, {TRACE: {"environment": None, "is_evaluation": False}})

        dt.enqueue_detector_runs(PROJECT, {TRACE})

        mock_add_job.assert_called_once()
        assert mock_add_job.call_args.args[1]["traceId"] == TRACE

    def test_mixed_batch_skips_only_the_summary_less_trace(
        self, fake_redis, mock_add_job, monkeypatch
    ):
        internal_trace = "cc" * 16
        _patch_detectors(monkeypatch, [_detector("d1", sample_rate=100)])
        _patch_summaries(monkeypatch, {TRACE: {"is_evaluation": False}})

        dt.enqueue_detector_runs(PROJECT, {TRACE, internal_trace})

        assert mock_add_job.call_count == 1
        assert mock_add_job.call_args.args[1]["traceId"] == TRACE
        assert _lock_state(fake_redis, trace_id=internal_trace) is None


class TestTraceSummaryEvaluationFlag:
    """``is_evaluation`` must come from the ingest-set flag, aggregated monotonically."""

    def _summaries(self, monkeypatch, result_rows):
        captured = {}

        class FakeCH:
            def query(self, sql, parameters=None):
                captured["sql"] = sql
                captured["parameters"] = parameters
                return MagicMock(result_rows=result_rows)

        monkeypatch.setattr(
            "db.clickhouse.client.get_clickhouse_client", lambda: FakeCH(), raising=False
        )
        summaries = dt._get_trace_summaries(PROJECT, [TRACE], include_trace_metadata=False)
        return summaries, captured

    def test_flag_comes_from_is_evaluation_not_environment(self, monkeypatch):
        summaries, captured = self._summaries(
            monkeypatch, [(TRACE, ["production"], [], 0.0, 0, None, 0, [{}], None, 1)]
        )

        assert summaries[TRACE]["is_evaluation"] is True
        sql = captured["sql"]
        # Aggregated over ALL the trace's spans, not read off the root. OTel exports a
        # span when it ENDS, so the EVALUATION root is normally the LAST span to arrive —
        # a root-keyed read would answer "not an evaluation" until then, and forever if
        # the eval process dies first. max() is also monotonic: no row can clear it.
        assert "max(is_evaluation)" in sql
        assert "parent_span_id IS NULL AND span_kind" not in sql
        # The flag must NOT be derived from the user-controlled environment string.
        assert "environment = 'evaluation'" not in sql

    def test_unflagged_trace_yields_false_even_when_named_evaluation(self, monkeypatch):
        summaries, _ = self._summaries(
            monkeypatch, [(TRACE, ["evaluation"], [], 0.0, 0, None, 0, [{}], None, 0)]
        )

        # environment says "evaluation" (a customer's own deployment naming) but the
        # ingest flag does not — the trace is NOT an evaluation trace.
        assert summaries[TRACE]["is_evaluation"] is False
        assert summaries[TRACE]["environment"] == ["evaluation"]
