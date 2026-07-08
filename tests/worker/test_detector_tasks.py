"""Unit tests for the exactly-once detector enqueue path (Redis lock + BullMQ)."""

import json
import sys
import threading
import types
from collections import OrderedDict
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


# ── Trigger condition evaluation ───────────────────────────────────────


class TestTriggerConditionEvaluation:
    def test_missing_field_does_not_pass_not_equal(self):
        assert dt._eval_condition({}, {"field": "status", "op": "!=", "value": "ERROR"}) is False

    @pytest.mark.parametrize(
        ("condition", "expected"),
        [
            pytest.param(
                {"field": "environment", "op": "=", "value": None}, True, id="equals-null"
            ),
            pytest.param(
                {"field": "environment", "op": "!=", "value": None},
                False,
                id="not-equals-null",
            ),
            pytest.param(
                {"field": "environment", "op": "!=", "value": "production"},
                True,
                id="not-equals-string",
            ),
        ],
    )
    def test_present_null_uses_scalar_equality(self, condition, expected):
        assert dt._eval_condition({"environment": None}, condition) is expected

    @pytest.mark.parametrize(
        "condition",
        [
            pytest.param("environment=production", id="string-condition"),
            pytest.param({"op": "=", "value": "production"}, id="missing-field"),
            pytest.param({"field": "environment", "value": "production"}, id="missing-op"),
            pytest.param({"field": "environment", "op": "="}, id="missing-value"),
        ],
    )
    def test_malformed_condition_returns_false(self, condition):
        assert dt._eval_condition({"environment": "production"}, condition) is False

    def test_missing_value_is_not_treated_as_explicit_null(self):
        assert (
            dt._eval_condition({"environment": None}, {"field": "environment", "op": "="}) is False
        )

    @pytest.mark.parametrize("op", ["=", "!="])
    @pytest.mark.parametrize(
        "value",
        [
            pytest.param({}, id="object"),
            pytest.param([], id="array"),
            pytest.param(True, id="true"),
            pytest.param(False, id="false"),
            pytest.param(42, id="integer"),
            pytest.param(3.14, id="float"),
        ],
    )
    def test_malformed_environment_equality_value_returns_false(self, op, value):
        assert (
            dt._eval_condition(
                {"environment": "production"},
                {"field": "environment", "op": op, "value": value},
            )
            is False
        )

    @pytest.mark.parametrize("op", ["=", "!="])
    @pytest.mark.parametrize(
        "actual",
        [
            pytest.param({}, id="object"),
            pytest.param([], id="array"),
            pytest.param(True, id="true"),
            pytest.param(False, id="false"),
            pytest.param(42, id="integer"),
            pytest.param(3.14, id="float"),
        ],
    )
    def test_malformed_environment_actual_value_returns_false(self, op, actual):
        assert (
            dt._eval_condition(
                {"environment": actual},
                {"field": "environment", "op": op, "value": "production"},
            )
            is False
        )

    @pytest.mark.parametrize(
        ("op", "expected"),
        [
            pytest.param("eq", True, id="eq"),
            pytest.param("ne", False, id="ne"),
            pytest.param("neq", False, id="neq"),
        ],
    )
    def test_legacy_equality_aliases_are_supported(self, op, expected):
        assert (
            dt._eval_condition(
                {"environment": "production"},
                {"field": "environment", "op": op, "value": "production"},
            )
            is expected
        )

    @pytest.mark.parametrize("op", [">", ">=", "<", "<=", "gt", "gte", "lt", "lte"])
    def test_numeric_fields_are_unsupported_until_summaries_include_them(self, op):
        assert dt._eval_condition({"cost": "10"}, {"field": "cost", "op": op, "value": 5}) is False

    @pytest.mark.parametrize(
        ("trace_summary", "condition"),
        [
            pytest.param(
                {"cost": "100.5"},
                {"field": "cost", "op": ">", "value": "abc"},
                id="invalid-expected-value",
            ),
            pytest.param(
                {"cost": "100.5"},
                {"field": "cost", "op": "<", "value": True},
                id="boolean-expected-value",
            ),
            pytest.param(
                {"cost": "slow"},
                {"field": "cost", "op": ">", "value": 10},
                id="invalid-actual-value",
            ),
            pytest.param(
                {"cost": "nan"},
                {"field": "cost", "op": ">", "value": 10},
                id="nan-actual-value",
            ),
            pytest.param(
                {"cost": "inf"},
                {"field": "cost", "op": ">", "value": 10},
                id="infinite-actual-value",
            ),
        ],
    )
    def test_unsupported_numeric_conditions_return_false(self, trace_summary, condition):
        assert dt._eval_condition(trace_summary, condition) is False

    def test_non_list_stored_trigger_conditions_fail_closed(self):
        object_condition = {"field": "environment", "op": "!=", "value": "prod"}
        json_object_condition = '{"field": "environment", "op": "!=", "value": "prod"}'

        assert dt._coerce_trigger_conditions(object_condition) == [None]
        assert dt._coerce_trigger_conditions(json_object_condition) == [None]
        assert (
            dt._passes_trigger(
                {"environment": "staging"},
                dt._coerce_trigger_conditions(object_condition),
            )
            is False
        )

    def test_malformed_json_string_trigger_conditions_fail_closed(self):
        conditions = dt._coerce_trigger_conditions("{bad json")

        assert conditions == [None]
        assert dt._passes_trigger({"environment": "staging"}, conditions) is False

    def test_json_string_trigger_condition_array_remains_supported(self):
        conditions = dt._coerce_trigger_conditions(
            '[{"field": "environment", "op": "eq", "value": "production"}]',
            has_trigger=True,
        )

        assert conditions == [{"field": "environment", "op": "eq", "value": "production"}]
        assert dt._passes_trigger({"environment": "production"}, conditions) is True

    def test_null_condition_without_trigger_row_remains_always_pass(self):
        assert dt._coerce_trigger_conditions(None, has_trigger=False) == []

    @pytest.mark.parametrize("conditions", [None, "null"])
    def test_null_condition_with_trigger_row_fails_closed(self, conditions):
        assert dt._coerce_trigger_conditions(conditions, has_trigger=True) == [None]
        assert (
            dt._passes_trigger(
                {"environment": "staging"},
                dt._coerce_trigger_conditions(conditions, has_trigger=True),
            )
            is False
        )

    def test_get_active_detectors_uses_trigger_row_presence(self, monkeypatch):
        rows = [
            ("no-trigger", 100, False, None),
            ("json-null", 100, True, "null"),
            ("db-null", 100, True, None),
            ("malformed-json", 100, True, "{bad json"),
            (
                "valid-trigger",
                100,
                True,
                [{"field": "environment", "op": "=", "value": "production"}],
            ),
        ]
        cursor = None

        class FakeCursor:
            def __enter__(self):
                return self

            def __exit__(self, exc_type, exc, tb):
                return False

            def execute(self, query, params):
                self.query = query
                self.params = params

            def fetchall(self):
                return rows

        class FakeConnection:
            closed = False

            def cursor(self):
                nonlocal cursor
                cursor = FakeCursor()
                return cursor

            def close(self):
                self.closed = True

        fake_conn = FakeConnection()
        monkeypatch.setitem(
            sys.modules,
            "psycopg2",
            types.SimpleNamespace(connect=lambda database_url: fake_conn),
        )

        detectors = dt._get_active_detectors(PROJECT)

        assert cursor is not None
        assert "SELECT d.id, d.sample_rate, dt.id IS NOT NULL AS has_trigger, dt.conditions" in (
            " ".join(cursor.query.split())
        )
        assert cursor.params == (PROJECT,)
        assert detectors == [
            {"id": "no-trigger", "sample_rate": 100, "conditions": []},
            {"id": "json-null", "sample_rate": 100, "conditions": [None]},
            {"id": "db-null", "sample_rate": 100, "conditions": [None]},
            {"id": "malformed-json", "sample_rate": 100, "conditions": [None]},
            {
                "id": "valid-trigger",
                "sample_rate": 100,
                "conditions": [{"field": "environment", "op": "=", "value": "production"}],
            },
        ]
        assert fake_conn.closed is True

    def test_get_active_detectors_warns_once_for_unsupported_conditions(self, monkeypatch, caplog):
        rows = [
            (
                "legacy-status",
                100,
                True,
                [{"field": "status", "op": "!=", "value": "ERROR"}],
            ),
            (
                "missing-op",
                100,
                True,
                [{"field": "environment", "value": "production"}],
            ),
            ("malformed-entry", 100, True, [None]),
            (
                "valid-trigger",
                100,
                True,
                [{"field": "environment", "op": "=", "value": "production"}],
            ),
        ]

        class FakeCursor:
            def __enter__(self):
                return self

            def __exit__(self, exc_type, exc, tb):
                return False

            def execute(self, query, params):
                pass

            def fetchall(self):
                return rows

        class FakeConnection:
            def cursor(self):
                return FakeCursor()

            def close(self):
                pass

        monkeypatch.setitem(
            sys.modules,
            "psycopg2",
            types.SimpleNamespace(connect=lambda database_url: FakeConnection()),
        )
        monkeypatch.setattr(dt, "_UNSUPPORTED_TRIGGER_WARNING_IDS", OrderedDict())

        with caplog.at_level("WARNING"):
            dt._get_active_detectors(PROJECT)
            dt._get_active_detectors(PROJECT)

        warnings = [
            record
            for record in caplog.records
            if "unsupported or malformed trigger conditions" in record.message
        ]
        assert len(warnings) == 3
        assert {record.args[0] for record in warnings} == {
            "legacy-status",
            "malformed-entry",
            "missing-op",
        }

    def test_get_active_detectors_resets_warning_dedupe_after_supported_conditions(
        self, monkeypatch, caplog
    ):
        rows = [
            (
                "det-1",
                100,
                True,
                [{"field": "duration", "op": "gt", "value": 1000}],
            )
        ]

        class FakeCursor:
            def __enter__(self):
                return self

            def __exit__(self, exc_type, exc, tb):
                return False

            def execute(self, query, params):
                pass

            def fetchall(self):
                return rows

        class FakeConnection:
            def cursor(self):
                return FakeCursor()

            def close(self):
                pass

        monkeypatch.setitem(
            sys.modules,
            "psycopg2",
            types.SimpleNamespace(connect=lambda database_url: FakeConnection()),
        )
        monkeypatch.setattr(dt, "_UNSUPPORTED_TRIGGER_WARNING_IDS", OrderedDict())

        with caplog.at_level("WARNING"):
            dt._get_active_detectors(PROJECT)
            dt._get_active_detectors(PROJECT)
            rows[:] = [
                (
                    "det-1",
                    100,
                    True,
                    [{"field": "environment", "op": "=", "value": "production"}],
                )
            ]
            dt._get_active_detectors(PROJECT)
            rows[:] = [
                (
                    "det-1",
                    100,
                    True,
                    [{"field": "duration", "op": "gt", "value": 1000}],
                )
            ]
            dt._get_active_detectors(PROJECT)

        warnings = [
            record
            for record in caplog.records
            if "unsupported or malformed trigger conditions" in record.message
        ]
        assert len(warnings) == 2
        assert [record.args[0] for record in warnings] == ["det-1", "det-1"]

    def test_get_active_detectors_resets_warning_dedupe_after_detector_leaves_active_set(
        self, monkeypatch, caplog
    ):
        rows = [
            (
                "det-1",
                100,
                True,
                [{"field": "duration", "op": "gt", "value": 1000}],
            )
        ]

        class FakeCursor:
            def __enter__(self):
                return self

            def __exit__(self, exc_type, exc, tb):
                return False

            def execute(self, query, params):
                pass

            def fetchall(self):
                return rows

        class FakeConnection:
            def cursor(self):
                return FakeCursor()

            def close(self):
                pass

        monkeypatch.setitem(
            sys.modules,
            "psycopg2",
            types.SimpleNamespace(connect=lambda database_url: FakeConnection()),
        )
        monkeypatch.setattr(dt, "_UNSUPPORTED_TRIGGER_WARNING_IDS", OrderedDict())

        with caplog.at_level("WARNING"):
            dt._get_active_detectors(PROJECT)
            dt._get_active_detectors(PROJECT)
            rows[:] = []
            dt._get_active_detectors(PROJECT)
            rows[:] = [
                (
                    "det-1",
                    100,
                    True,
                    [{"field": "duration", "op": "gt", "value": 1000}],
                )
            ]
            dt._get_active_detectors(PROJECT)
            rows[:] = [("det-1", 100, False, None)]
            dt._get_active_detectors(PROJECT)
            rows[:] = [
                (
                    "det-1",
                    100,
                    True,
                    [{"field": "duration", "op": "gt", "value": 1000}],
                )
            ]
            dt._get_active_detectors(PROJECT)

        warnings = [
            record
            for record in caplog.records
            if "unsupported or malformed trigger conditions" in record.message
        ]
        assert len(warnings) == 3
        assert [record.args[0] for record in warnings] == ["det-1", "det-1", "det-1"]

    def test_unsupported_trigger_warning_dedupe_is_bounded(self, monkeypatch):
        monkeypatch.setattr(dt, "_UNSUPPORTED_TRIGGER_WARNING_LIMIT", 2)
        monkeypatch.setattr(dt, "_UNSUPPORTED_TRIGGER_WARNING_IDS", OrderedDict())

        bad_conditions = [{"field": "duration", "op": "gt", "value": 1000}]

        assert dt._mark_unsupported_trigger_warning_seen(PROJECT, "det-1", bad_conditions) is True
        assert dt._mark_unsupported_trigger_warning_seen(PROJECT, "det-2", bad_conditions) is True
        assert dt._mark_unsupported_trigger_warning_seen(PROJECT, "det-1", bad_conditions) is False
        assert dt._mark_unsupported_trigger_warning_seen(PROJECT, "det-3", bad_conditions) is False

        assert [key[1] for key in dt._UNSUPPORTED_TRIGGER_WARNING_IDS] == ["det-2", "det-1"]
        assert dt._mark_unsupported_trigger_warning_seen(PROJECT, "det-2", bad_conditions) is False

    def test_get_active_detectors_does_not_rewarn_after_warning_cache_capacity(
        self, monkeypatch, caplog
    ):
        rows = [
            ("det-1", 100, True, [{"field": "duration", "op": "gt", "value": 1000}]),
            ("det-2", 100, True, [{"field": "status", "op": "=", "value": "ERROR"}]),
            ("det-3", 100, True, [{"field": "cost", "op": "gt", "value": 1}]),
        ]

        class FakeCursor:
            def __enter__(self):
                return self

            def __exit__(self, exc_type, exc, tb):
                return False

            def execute(self, query, params):
                pass

            def fetchall(self):
                return rows

        class FakeConnection:
            def cursor(self):
                return FakeCursor()

            def close(self):
                pass

        monkeypatch.setitem(
            sys.modules,
            "psycopg2",
            types.SimpleNamespace(connect=lambda database_url: FakeConnection()),
        )
        monkeypatch.setattr(dt, "_UNSUPPORTED_TRIGGER_WARNING_LIMIT", 2)
        monkeypatch.setattr(dt, "_UNSUPPORTED_TRIGGER_WARNING_IDS", OrderedDict())
        monkeypatch.setattr(dt, "_UNSUPPORTED_TRIGGER_WARNING_SUPPRESSED_PROJECTS", OrderedDict())

        with caplog.at_level("WARNING"):
            dt._get_active_detectors(PROJECT)
            dt._get_active_detectors(PROJECT)

        warnings = [
            record
            for record in caplog.records
            if "unsupported or malformed trigger conditions" in record.message
        ]
        assert len(warnings) == 2
        assert [record.args[0] for record in warnings] == ["det-1", "det-2"]
        assert [key[1] for key in dt._UNSUPPORTED_TRIGGER_WARNING_IDS] == ["det-1", "det-2"]
        suppression_warnings = [
            record
            for record in caplog.records
            if "Detector trigger warning cache" in record.message
        ]
        assert len(suppression_warnings) == 1
        assert suppression_warnings[0].args == (PROJECT,)

    def test_unsupported_trigger_warning_dedupe_tracks_condition_changes(self, monkeypatch):
        monkeypatch.setattr(dt, "_UNSUPPORTED_TRIGGER_WARNING_IDS", OrderedDict())

        first_bad_conditions = [{"field": "duration", "op": "gt", "value": 1000}]
        second_bad_conditions = [{"field": "status", "op": "=", "value": "ERROR"}]

        assert (
            dt._mark_unsupported_trigger_warning_seen(PROJECT, "det-1", first_bad_conditions)
            is True
        )
        assert (
            dt._mark_unsupported_trigger_warning_seen(PROJECT, "det-1", first_bad_conditions)
            is False
        )
        assert (
            dt._mark_unsupported_trigger_warning_seen(PROJECT, "det-1", second_bad_conditions)
            is True
        )

        dt._clear_unsupported_trigger_warning_seen(PROJECT, "det-1")

        assert (
            dt._mark_unsupported_trigger_warning_seen(PROJECT, "det-1", second_bad_conditions)
            is True
        )

    def test_unsupported_trigger_warning_dedupe_expires(self, monkeypatch):
        monkeypatch.setattr(dt, "_UNSUPPORTED_TRIGGER_WARNING_TTL_SECONDS", 10)
        monkeypatch.setattr(dt, "_UNSUPPORTED_TRIGGER_WARNING_IDS", OrderedDict())
        now = 1000.0
        monkeypatch.setattr(dt.time, "monotonic", lambda: now)

        bad_conditions = [{"field": "duration", "op": "gt", "value": 1000}]

        assert dt._mark_unsupported_trigger_warning_seen(PROJECT, "det-1", bad_conditions) is True
        assert dt._mark_unsupported_trigger_warning_seen(PROJECT, "det-1", bad_conditions) is False

        now = 1011.0

        assert dt._mark_unsupported_trigger_warning_seen(PROJECT, "det-1", bad_conditions) is True

    @pytest.mark.parametrize("op", ["=", "!="])
    def test_legacy_status_condition_is_inert(self, op):
        assert (
            dt._passes_trigger(
                {"environment": "production"},
                [{"field": "status", "op": op, "value": "ERROR"}],
            )
            is False
        )

    @pytest.mark.parametrize(
        "condition",
        [
            pytest.param(None, id="null-entry"),
            pytest.param({"field": "status", "op": "!=", "value": "ERROR"}, id="unsupported-field"),
            pytest.param({"field": "environment", "value": "production"}, id="missing-op"),
            pytest.param({"field": "environment", "op": "="}, id="missing-value"),
            pytest.param({"field": "environment", "op": "=", "value": []}, id="bad-value"),
        ],
    )
    def test_unsupported_trigger_condition_detection(self, condition):
        assert dt._has_unsupported_trigger_conditions([condition]) is True

    def test_supported_trigger_conditions_are_not_marked_unsupported(self):
        assert (
            dt._has_unsupported_trigger_conditions(
                [
                    {"field": "environment", "op": "eq", "value": "production"},
                    {"field": "environment", "op": "!=", "value": None},
                ]
            )
            is False
        )


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

        dt.enqueue_detector_runs(PROJECT, {TRACE})

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

        # No root span arrived in this batch → nothing to enqueue.
        dt.enqueue_detector_runs(PROJECT, set())

        mock_add_job.assert_not_called()
        assert _lock_state(fake_redis) is None

    def test_duplicate_root_delivery_noops(self, fake_redis, mock_add_job, monkeypatch):
        """Second root delivery loses the NX claim — exactly one job ever added."""
        _patch_detectors(monkeypatch, [_detector("d1")])
        _patch_summaries(monkeypatch, {})

        dt.enqueue_detector_runs(PROJECT, {TRACE})
        first_value = fake_redis.store[dt._lock_key(PROJECT, TRACE)]

        dt.enqueue_detector_runs(PROJECT, {TRACE})

        assert mock_add_job.call_count == 1
        assert fake_redis.store[dt._lock_key(PROJECT, TRACE)] == first_value

    def test_sampled_out_is_sticky(self, fake_redis, mock_add_job, monkeypatch):
        """A no-sample decision is recorded and a replay must not re-roll it."""
        _patch_detectors(monkeypatch, [_detector("d1", sample_rate=0)])
        _patch_summaries(monkeypatch, {})

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

    def test_invalid_numeric_condition_fails_closed_without_stopping_batch(
        self, fake_redis, mock_add_job, monkeypatch
    ):
        """An invalid numeric trigger condition fails closed without stopping the batch."""
        other = "bb" * 16
        _patch_detectors(
            monkeypatch,
            [_detector("d1", conditions=[{"field": "cost", "op": ">", "value": "not-a-number"}])],
        )
        _patch_summaries(monkeypatch, {TRACE: {"cost": 5}, other: {}})

        dt.enqueue_detector_runs(PROJECT, {TRACE, other})

        # TRACE fails closed on the invalid numeric condition; `other` has cost
        # missing -> condition False -> sampled_out.
        assert mock_add_job.call_count == 0
        assert _lock_state(fake_redis, trace_id=TRACE)["state"] == "sampled_out"
        assert _lock_state(fake_redis, trace_id=other)["state"] == "sampled_out"

    def test_concurrent_claims_enqueue_exactly_once(self, fake_redis, monkeypatch):
        added = []
        monkeypatch.setattr(dt, "_add_bullmq_job", lambda job_id, data: added.append(job_id))
        _patch_detectors(monkeypatch, [_detector("d1")])
        _patch_summaries(monkeypatch, {})

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


# ── Failure release (token-checked) ─────────────────────────────────────


class TestFailureRelease:
    def test_enqueue_failure_releases_lock_and_allows_reclaim(
        self, fake_redis, mock_add_job, monkeypatch
    ):
        _patch_detectors(monkeypatch, [_detector("d1")])
        _patch_summaries(monkeypatch, {})

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
        _patch_summaries(monkeypatch, {})
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
