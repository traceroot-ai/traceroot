"""Unit tests for the alert evaluation service."""

import threading
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from unittest.mock import MagicMock

import pytest

from rest.schemas.alerts import MAX_ALERT_WINDOW, MAX_ALERT_WINDOW_END_LAG, AlertEvaluationSpec
from rest.services import alert_evaluation as ae
from rest.services import widget_query as wq
from rest.services.alert_evaluation import evaluate_alerts
from rest.services.widget_query import WidgetSpecError


def _utcnow_naive() -> datetime:
    return datetime.now(UTC).replace(tzinfo=None)


# The service refuses a window ending more than MAX_ALERT_WINDOW_END_LAG behind now.
END = _utcnow_naive().replace(microsecond=0)
START = END - timedelta(hours=1)


class _FakeClickHouse:
    """One canned folded result — ``(value, row_count)`` or ``_NO_ROWS`` — per query."""

    def __init__(self, results):
        self._results = list(results)
        self._lock = threading.Lock()
        self.calls = []

    def query(self, sql, parameters=None, settings=None):
        with self._lock:
            self.calls.append((sql, parameters))
            assert self._results, f"unexpected extra query: {sql}"
            return _folded_result(self._results.pop(0))

    @property
    def sqls(self):
        return [sql for sql, _ in self.calls]


def _folded_result(item):
    rows = [] if item is _NO_ROWS else [tuple(item)]
    return MagicMock(column_names=["value", "row_count"], result_rows=rows)


_NO_ROWS = object()


@pytest.fixture()
def fake_ch(monkeypatch):
    """Install a canned client and pin evaluation to one worker.

    The canned results pop in request order, which only maps to alerts
    deterministically when the pool is serial; the overlap itself is proved by
    ``test_a_chunk_s_queries_overlap_rather_than_queue`` below.
    """

    def install(*results):
        client = _FakeClickHouse(results)
        monkeypatch.setattr(wq, "get_clickhouse_client", lambda: client)
        monkeypatch.setattr(ae, "_MAX_CONCURRENT_QUERIES", 1)
        return client

    return install


def make_alert(**overrides) -> AlertEvaluationSpec:
    payload = {
        "alert_id": "alert-1",
        "view": "SPANS",
        "measure": "latency",
        "aggregation": "avg",
        "filters": [],
    }
    payload.update(overrides)
    return AlertEvaluationSpec.model_validate(payload)


def evaluate(alerts, project_id="proj-1", start=START, end=END):
    return evaluate_alerts(alerts, project_id=project_id, window_start=start, window_end=end)


# --- The count sentinel ---


def test_zero_row_window_and_null_aggregate_are_distinguishable(fake_ch):
    """A null aggregate is a measure problem; a window with no rows is ingest having stopped."""
    fake_ch((None, 0))
    empty_window = evaluate([make_alert()])[0]

    fake_ch((None, 41))
    null_aggregate = evaluate([make_alert()])[0]

    assert empty_window.value is None and empty_window.row_count == 0
    assert null_aggregate.value is None and null_aggregate.row_count == 41
    assert empty_window != null_aggregate


def test_an_empty_window_keeps_an_additive_zero_and_withholds_the_rest(fake_ch):
    fake_ch((0.0, 0))
    summed = evaluate([make_alert(measure="cost", aggregation="sum")])[0]

    fake_ch((0.0, 0))
    smallest = evaluate([make_alert(measure="latency", aggregation="min")])[0]

    assert summed.value == 0.0
    assert smallest.value is None
    assert summed.row_count == 0 and smallest.row_count == 0


def test_absent_result_row_reads_as_a_null_value(fake_ch):
    ch = fake_ch(_NO_ROWS)
    result = evaluate([make_alert()])[0]
    assert result.value is None
    assert result.row_count == 0
    assert len(ch.calls) == 1


def test_count_measure_issues_exactly_one_query(fake_ch):
    """The measure and the folded row count ride the same query."""
    ch = fake_ch((137, 137))
    result = evaluate([make_alert(measure="count", aggregation="count")])[0]

    assert len(ch.calls) == 1
    assert result.value == 137.0
    assert result.row_count == 137


def test_count_measure_with_no_result_reports_zero_rows(fake_ch):
    """The absent value is zero rows, not an unknown row count."""
    fake_ch(_NO_ROWS)
    result = evaluate([make_alert(measure="count", aggregation="count")])[0]
    assert result.value is None
    assert result.row_count == 0


def test_non_count_measure_folds_the_row_count_into_its_own_query(fake_ch):
    """One query per alert: the count(*) sentinel used to be a second, serial query."""
    ch = fake_ch((250.0, 9))
    result = evaluate([make_alert()])[0]

    assert len(ch.calls) == 1
    assert "avg(duration_ms)" in ch.sqls[0]
    assert "count() AS row_count" in ch.sqls[0]
    assert result.value == 250.0
    assert result.row_count == 9


def test_the_row_count_shares_the_measure_s_window_and_filters(fake_ch):
    """A row count over a different population would not describe the aggregate it qualifies.

    Folded into the measure's own SELECT, it structurally cannot diverge."""
    ch = fake_ch((1.0, 4))
    evaluate(
        [make_alert(filters=[{"field": "span_kind", "op": "=", "value": "LLM"}])],
    )

    assert len(ch.calls) == 1
    assert "count() AS row_count" in ch.sqls[0]
    params = ch.calls[0][1]
    assert params["start_time"] == START
    assert params["end_time"] == END
    assert params["f0"] == "LLM"


def test_row_count_of_a_fractional_sentinel_is_an_integer(fake_ch):
    fake_ch((5.0, 3.0))
    result = evaluate([make_alert()])[0]
    assert result.row_count == 3
    assert isinstance(result.row_count, int)


# --- Non-finite normalisation ---


@pytest.mark.parametrize("raw", [float("nan"), float("inf"), float("-inf")])
def test_non_finite_aggregate_normalises_to_null(fake_ch, raw):
    """NaN has no JSON spelling and infinities are not a threshold anyone set."""
    fake_ch((raw, 6))
    result = evaluate([make_alert()])[0]
    assert result.value is None
    assert result.row_count == 6


def test_a_non_finite_value_is_still_not_a_zero_row_window(fake_ch):
    fake_ch((float("nan"), 6))
    non_finite = evaluate([make_alert()])[0]

    fake_ch((float("nan"), 0))
    no_rows = evaluate([make_alert()])[0]

    assert non_finite.value is None and no_rows.value is None
    assert non_finite.row_count == 6
    assert no_rows.row_count == 0


def test_decimal_scalar_becomes_a_float(fake_ch):
    """ClickHouse returns Decimal for cost columns; the response contract is a JSON number."""
    fake_ch((Decimal("1.25"), 2))
    result = evaluate([make_alert(measure="cost", aggregation="sum")])[0]
    assert result.value == 1.25
    assert isinstance(result.value, float)


# --- Per-alert isolation ---


def test_one_alert_failing_does_not_fail_its_siblings(fake_ch):
    """One bad rule must not cost the tick every other rule's evaluation."""
    ch = fake_ch()

    def flaky_query(sql, parameters=None, settings=None):
        ch.calls.append((sql, parameters))
        if len(ch.calls) == 1:
            raise RuntimeError("clickhouse connection reset")
        return _folded_result((3.0, 3))

    ch.query = flaky_query
    broken, fine_1, fine_2 = evaluate(
        [
            make_alert(alert_id="broken"),
            make_alert(alert_id="fine-1"),
            make_alert(alert_id="fine-2"),
        ]
    )
    assert broken.alert_id == "broken"
    assert broken.value is None
    assert broken.error == "Query execution failed"
    assert (fine_1.error, fine_2.error) == (None, None)
    assert fine_1.value == 3.0 and fine_2.value == 3.0


def test_a_query_failure_does_not_leak_its_internals(fake_ch):
    """A driver's stack detail is neither actionable in the operator's log nor safe to echo."""
    ch = fake_ch()

    def boom(sql, parameters=None, settings=None):
        raise RuntimeError("Code: 241. DB::Exception: Memory limit exceeded, host=10.0.0.4")

    ch.query = boom
    result = evaluate([make_alert()])[0]
    assert result.error == "Query execution failed"
    assert "10.0.0.4" not in result.error


def test_unknown_measure_is_that_alert_s_error_not_a_batch_rejection(fake_ch):
    """Measure stays a plain string so a stale rule is one alert's problem, not a rejection."""
    ch = fake_ch((1.0, 1))
    results = evaluate(
        [make_alert(alert_id="stale", measure="p99_vibes"), make_alert(alert_id="ok")]
    )

    assert results[0].error == "measure: Unknown alert measure 'p99_vibes'"
    assert results[0].value is None
    assert results[1].error is None
    # The rejected alert never reached ClickHouse.
    assert len(ch.calls) == 1


def test_unsupported_view_is_that_alert_s_error(fake_ch):
    fake_ch()
    result = evaluate([make_alert(view="TRACES")])[0]
    assert result.error == "view: Unsupported alert view 'TRACES'"


def test_an_aggregation_the_field_forbids_is_that_alert_s_error(fake_ch):
    """The engine's per-field aggregation rule is the authority for the step and message."""
    fake_ch()
    result = evaluate([make_alert(measure="trace_id", aggregation="sum")])[0]
    assert result.error is not None
    assert result.error.startswith("metric:")
    assert result.value is None


# --- Traces-routed measures ---


def test_unfiltered_unique_id_measure_reads_the_traces_view(fake_ch):
    """An unfiltered distinct count over traces equals the same count over spans."""
    ch = fake_ch((12, 30))
    result = evaluate([make_alert(measure="unique_user_ids", aggregation="uniq")])[0]

    assert result.value == 12.0
    assert result.row_count == 30
    assert "uniqExact(user_id)" in ch.sqls[0]


def test_filtered_traces_routed_measure_is_refused(fake_ch):
    ch = fake_ch()
    result = evaluate(
        [
            make_alert(
                measure="unique_session_ids",
                aggregation="uniq",
                filters=[{"field": "span_kind", "op": "=", "value": "LLM"}],
            )
        ]
    )[0]

    assert result.error == "filters: Measure 'unique_session_ids' cannot carry span filters"
    assert result.value is None
    assert ch.calls == []


def test_span_routed_measures_keep_their_filters(fake_ch):
    ch = fake_ch((4.0, 4))
    result = evaluate([make_alert(filters=[{"field": "span_kind", "op": "=", "value": "LLM"}])])[0]
    assert result.error is None
    assert ch.calls[0][1]["f0"] == "LLM"


# --- Window handling ---


def test_reversed_window_raises_rather_than_reporting_n_identical_errors(fake_ch):
    """A bad window per alert would hide a caller bug behind N plausible per-alert failures."""
    ch = fake_ch()
    with pytest.raises(WidgetSpecError) as excinfo:
        evaluate([make_alert(), make_alert(alert_id="alert-2")], start=END, end=START)
    assert excinfo.value.step == "time_range"
    assert ch.calls == []


def test_a_window_at_the_ceiling_is_accepted(fake_ch):
    """The ceiling matches the longest window token a rule can carry, so a 2h alert measures."""
    ch = fake_ch((3.0, 7))
    result = evaluate([make_alert()], start=END - MAX_ALERT_WINDOW, end=END)[0]

    assert result.error is None
    assert result.value == 3.0
    assert ch.calls[0][1]["end_time"] == END


def test_a_window_past_the_ceiling_raises_before_any_query_runs(fake_ch):
    """The endpoint skips retention clamping on the strength of this ceiling."""
    ch = fake_ch()
    with pytest.raises(WidgetSpecError) as excinfo:
        evaluate([make_alert()], start=END - MAX_ALERT_WINDOW - timedelta(seconds=1), end=END)

    assert excinfo.value.step == "time_range"
    assert ch.calls == []


# --- The window anchor ---


def test_a_window_ending_inside_the_lag_tolerance_is_accepted(fake_ch):
    """The anchor bound leaves room for the evaluation offset, clock skew and a slow claim."""
    # Anchored on a fresh clock read rather than END: the suite's runtime would eat the margin.
    end = _utcnow_naive() - MAX_ALERT_WINDOW_END_LAG + timedelta(minutes=1)
    ch = fake_ch((2.0, 5))
    result = evaluate([make_alert()], start=end - timedelta(minutes=10), end=end)[0]

    assert result.error is None
    assert result.value == 2.0
    assert ch.calls[0][1]["end_time"] == end


def test_a_window_anchored_further_back_than_the_lag_raises_before_any_query(fake_ch):
    """The span cap bounds only the window's width, not how far back it may be walked."""
    end = _utcnow_naive() - MAX_ALERT_WINDOW_END_LAG - timedelta(seconds=1)
    ch = fake_ch()
    with pytest.raises(WidgetSpecError) as excinfo:
        evaluate([make_alert()], start=end - timedelta(minutes=10), end=end)

    assert excinfo.value.step == "time_range"
    assert excinfo.value.message == (
        f"window_end must be within {int(MAX_ALERT_WINDOW_END_LAG.total_seconds())} seconds of now"
    )
    assert ch.calls == []


def test_a_stale_anchor_is_refused_even_at_a_legal_span(fake_ch):
    end = _utcnow_naive() - MAX_ALERT_WINDOW_END_LAG - timedelta(hours=6)
    ch = fake_ch()
    with pytest.raises(WidgetSpecError) as excinfo:
        evaluate([make_alert()], start=end - MAX_ALERT_WINDOW, end=end)

    assert excinfo.value.step == "time_range"
    assert ch.calls == []


def test_empty_window_raises(fake_ch):
    ch = fake_ch()
    with pytest.raises(WidgetSpecError):
        evaluate([make_alert()], start=START, end=START)
    assert ch.calls == []


def test_aware_window_edges_reach_clickhouse_naive_in_utc(fake_ch):
    """ClickHouse DateTime64 parameters take naive UTC; the tick sends offset-carrying stamps."""
    ch = fake_ch((1.0, 1))
    evaluate([make_alert()], start=START.replace(tzinfo=UTC), end=END.replace(tzinfo=UTC))
    params = ch.calls[0][1]
    assert params["start_time"] == START
    assert params["end_time"] == END
    assert params["start_time"].tzinfo is None
    assert params["end_time"].tzinfo is None


# --- Batch contract ---


def test_results_come_back_one_per_alert_in_request_order(fake_ch):
    """The caller matches results to claimed rules positionally as well as by id."""
    fake_ch((1.0, 1), (2.0, 2), (3.0, 3))
    results = evaluate([make_alert(alert_id=f"a{i}") for i in range(3)])
    assert [r.alert_id for r in results] == ["a0", "a1", "a2"]
    assert [r.value for r in results] == [1.0, 2.0, 3.0]


def test_duplicate_alert_ids_still_produce_one_result_each(fake_ch):
    fake_ch((1.0, 1), (2.0, 2))
    results = evaluate([make_alert(alert_id="same"), make_alert(alert_id="same")])
    assert [r.value for r in results] == [1.0, 2.0]


def test_an_empty_batch_runs_no_queries(fake_ch):
    ch = fake_ch()
    assert evaluate([]) == []
    assert ch.calls == []


def test_project_scoping_is_bound_into_every_query(fake_ch):
    """Both the measure and its sentinel must carry the project or one reads another tenant."""
    ch = fake_ch((1.0, 1))
    evaluate([make_alert()], project_id="proj-xyz")
    assert all(params["project_id"] == "proj-xyz" for _, params in ch.calls)


# --- Concurrency ---


def test_a_chunk_s_queries_overlap_rather_than_queue(monkeypatch):
    """Serial evaluation cost chunk-size × the query cap against the caller's 30s abort.

    The barrier only releases once all three queries are in flight at the same
    time, so this fails — every alert reporting a query error — if evaluation
    goes back to one-at-a-time."""
    barrier = threading.Barrier(3, timeout=5)

    class _BlockingClickHouse:
        def query(self, sql, parameters=None, settings=None):
            barrier.wait()
            return _folded_result((1.0, 1))

    monkeypatch.setattr(wq, "get_clickhouse_client", lambda: _BlockingClickHouse())
    results = evaluate([make_alert(alert_id=f"a{i}") for i in range(3)])
    assert [r.error for r in results] == [None, None, None]
    assert [r.value for r in results] == [1.0, 1.0, 1.0]
