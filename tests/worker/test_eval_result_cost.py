"""Per-result cost derived from an evaluation trace must measure the CANDIDATE only.

The load-bearing rule: a scorer can call an LLM of its own — an ``llm_judge``
self-instruments its model call, and a hand-rolled ``@scorer`` may call a provider
directly — and that LLM span lands in the SAME trace, nested under the SCORER span.
Folding it into the result over-reports what the candidate cost to run, so the whole
scorer subtree is dropped before summing.

`rows` mirror the ClickHouse projection the worker queries:
``(trace_id, span_id, parent_span_id, span_kind, cost, input_tokens, output_tokens,
total_tokens, span_start_time, span_end_time)``.

The same exclusion governs TOKENS, and matters more there: an llm_judge reports usage
just as a candidate model call does, so a naive trace-wide sum would bill the candidate
for grading itself.
"""

from datetime import datetime, timedelta
from unittest.mock import MagicMock, patch

import pytest

from tests.fixtures.otel_payloads import make_attr, make_otel_payload, make_span
from worker.ingest_tasks import (
    _task_metrics_by_trace,
    _update_eval_result_costs,
    process_s3_traces,
)

T = "trace-1"


def _row(span_id, parent, kind, cost, *, tokens=None, ms=None, trace=T):
    """One ClickHouse span row.

    ``tokens`` is ``(input, output, total)``; ``ms`` a span duration in milliseconds,
    rendered as a start/end pair so the fold exercises the real subtraction.
    """
    it, ot, tt = tokens or (None, None, None)
    start = datetime(2026, 8, 24, 12, 0, 0)
    end = start + timedelta(milliseconds=ms) if ms is not None else None
    return (trace, span_id, parent, kind, cost, it, ot, tt, start, end)


def _cost(rows, trace=T):
    """The candidate-task cost, the property the original tests were written against."""
    return _task_metrics_by_trace(rows)[trace].cost


class TestScorerSubtreeIsExcluded:
    def test_llm_judge_call_under_a_scorer_is_not_charged_to_the_candidate(self):
        """The regression the whole function exists to prevent."""
        # EVALUATION -> TASK -> LLM(0.10)   (candidate)
        #            -> SCORER -> LLM(0.90) (judge — must not be charged)
        rows = [
            _row("root", None, "EVALUATION", None),
            _row("task", "root", "TASK", None),
            _row("task-llm", "task", "LLM", 0.10),
            _row("scorer", "root", "SCORER", None),
            _row("judge-llm", "scorer", "LLM", 0.90),
        ]
        assert _cost(rows) == pytest.approx(0.10)

    def test_nested_scorer_subtree_two_levels_deep_is_excluded(self):
        rows = [
            _row("root", None, "EVALUATION", None),
            _row("task", "root", "TASK", None),
            _row("task-llm", "task", "LLM", 0.25),
            _row("scorer", "root", "SCORER", None),
            _row("judge-agent", "scorer", "AGENT", None),
            _row("judge-llm", "judge-agent", "LLM", 5.00),
            _row("judge-tool", "judge-agent", "TOOL", 1.00),
        ]
        assert _cost(rows) == pytest.approx(0.25)

    def test_multiple_scorers_are_all_excluded(self):
        rows = [
            _row("root", None, "EVALUATION", None),
            _row("task", "root", "TASK", None),
            _row("task-llm", "task", "LLM", 0.40),
            _row("scorer-a", "root", "SCORER", None),
            _row("judge-a", "scorer-a", "LLM", 2.00),
            _row("scorer-b", "root", "SCORER", None),
            _row("judge-b", "scorer-b", "LLM", 3.00),
        ]
        assert _cost(rows) == pytest.approx(0.40)

    def test_a_scorer_carrying_cost_itself_is_excluded(self):
        rows = [
            _row("root", None, "EVALUATION", None),
            _row("task-llm", "root", "LLM", 0.10),
            _row("scorer", "root", "SCORER", 7.00),
        ]
        assert _cost(rows) == pytest.approx(0.10)


class TestSummingContract:
    def test_none_costs_are_absent_not_zero_and_total_is_zero(self):
        rows = [
            _row("root", None, "EVALUATION", None),
            _row("task", "root", "TASK", None),
            _row("task-llm", "task", "LLM", None),
        ]
        assert _cost(rows) == 0.0

    def test_a_span_whose_parent_is_absent_is_still_summed(self):
        """Tolerated by design — an orphan is unreachable for exclusion, but dropping it
        would silently under-report. The two-way recompute corrects it once the parent
        lands."""
        rows = [
            _row("root", None, "EVALUATION", None),
            _row("orphan-llm", "missing-parent", "LLM", 0.30),
        ]
        assert _cost(rows) == pytest.approx(0.30)

    def test_multiple_traces_in_one_batch_do_not_bleed_into_each_other(self):
        rows = [
            _row("root-a", None, "EVALUATION", None, trace="trace-a"),
            _row("llm-a", "root-a", "LLM", 0.10, trace="trace-a"),
            _row("scorer-a", "root-a", "SCORER", None, trace="trace-a"),
            _row("judge-a", "scorer-a", "LLM", 9.00, trace="trace-a"),
            _row("root-b", None, "EVALUATION", None, trace="trace-b"),
            _row("llm-b", "root-b", "LLM", 0.20, trace="trace-b"),
        ]
        assert _cost(rows, "trace-a") == pytest.approx(0.10)
        assert _cost(rows, "trace-b") == pytest.approx(0.20)


class TestLlmMetricsShareTheExclusion:
    """Tokens, call count and LLM latency obey the SAME scorer-subtree rule as cost.

    This is the reason these are derived here rather than summed off the trace: an
    llm_judge reports usage exactly as a candidate model call does, so a trace-wide sum
    would bill the candidate for grading itself — and unlike cost, token counts are
    almost always present, so the error would be visible on every judged run.
    """

    def _metrics(self, rows):
        return _task_metrics_by_trace(rows)[T]

    def test_judge_tokens_are_not_charged_to_the_candidate(self):
        m = self._metrics(
            [
                _row("root", None, "EVALUATION", None),
                _row("task", "root", "TASK", None),
                _row("task-llm", "task", "LLM", 0.10, tokens=(18, 29, 47), ms=1060),
                _row("scorer", "root", "SCORER", None),
                _row("judge-llm", "scorer", "LLM", 0.90, tokens=(900, 900, 1800), ms=5000),
            ]
        )
        assert (m.prompt_tokens, m.completion_tokens, m.total_tokens) == (18, 29, 47)
        assert m.llm_calls == 1
        assert m.llm_duration_ms == 1060
        assert m.cost == pytest.approx(0.10)

    def test_several_candidate_calls_accumulate(self):
        m = self._metrics(
            [
                _row("root", None, "EVALUATION", None),
                _row("a", "root", "LLM", 0.01, tokens=(10, 5, 15), ms=100),
                _row("b", "root", "LLM", 0.02, tokens=(20, 7, 27), ms=250),
            ]
        )
        assert (m.prompt_tokens, m.completion_tokens, m.total_tokens) == (30, 12, 42)
        assert m.llm_calls == 2
        assert m.llm_duration_ms == 350

    def test_a_nested_judge_subtree_contributes_nothing(self):
        m = self._metrics(
            [
                _row("root", None, "EVALUATION", None),
                _row("task-llm", "root", "LLM", None, tokens=(5, 5, 10), ms=10),
                _row("scorer", "root", "SCORER", None),
                _row("judge-agent", "scorer", "AGENT", None),
                _row("judge-llm", "judge-agent", "LLM", None, tokens=(99, 99, 198), ms=9999),
            ]
        )
        assert m.total_tokens == 10
        assert m.llm_calls == 1
        assert m.llm_duration_ms == 10

    def test_llm_calls_counts_a_model_call_that_reported_no_usage(self):
        """Keyed on span_kind, not on "has tokens" — a provider that omits usage still
        made a call, and reporting 0 calls there would be wrong."""
        m = self._metrics(
            [
                _row("root", None, "EVALUATION", None),
                _row("silent", "root", "LLM", None, ms=40),
            ]
        )
        assert m.llm_calls == 1
        assert m.total_tokens == 0
        assert m.llm_duration_ms == 40

    def test_non_llm_spans_contribute_no_tokens_or_calls(self):
        """A TOOL/AGENT span is task work but not a model call."""
        m = self._metrics(
            [
                _row("root", None, "EVALUATION", None),
                _row("agent", "root", "AGENT", None, ms=500),
                _row("tool", "agent", "TOOL", None, ms=300),
                _row("llm", "agent", "LLM", 0.05, tokens=(1, 2, 3), ms=200),
            ]
        )
        assert m.llm_calls == 1
        assert m.llm_duration_ms == 200, "AGENT/TOOL wall-clock is not LLM time"
        assert m.total_tokens == 3

    def test_an_unfinished_span_contributes_no_duration(self):
        """A span still open has no end time; treating it as instantaneous is a guess,
        and the two-way recompute corrects it once the span closes."""
        m = self._metrics(
            [
                _row("root", None, "EVALUATION", None),
                _row("open", "root", "LLM", None, tokens=(1, 1, 2)),
            ]
        )
        assert m.llm_duration_ms == 0
        assert m.llm_calls == 1

    def test_a_trace_with_no_model_call_folds_to_zero(self):
        """Zero, which the writer turns into NULL — never a misleading 0 on the row."""
        m = self._metrics(
            [
                _row("root", None, "EVALUATION", None),
                _row("task", "root", "TASK", None, ms=5),
            ]
        )
        assert (m.total_tokens, m.llm_calls, m.llm_duration_ms) == (0, 0, 0)


class TestWriteIsUnconditional:
    """`if cost <= 0: continue` froze an over-report permanently. Under
    BatchSpanProcessor a parent exports after its children, so a scorer's LLM child can
    land in an earlier batch than the SCORER span; that batch has nothing to seed the
    exclusion set and writes an inflated cost. The batch that finally brings the SCORER
    recomputes 0.0 — and must be allowed to write it back."""

    def _run(self, rows):
        ch = MagicMock()
        ch.query.return_value.result_rows = rows
        conn, cur = MagicMock(), MagicMock()
        cur.fetchall.return_value = [(T,)]
        conn.cursor.return_value.__enter__.return_value = cur
        with patch("psycopg2.connect", return_value=conn):
            _update_eval_result_costs("proj-1", {T}, ch)
        # The per-trace COST write (NULLIF), not the separate `cost_derived_at` marking
        # UPDATE that stamps every examined row (asserted in test_ingest_tasks.py).
        return [c for c in cur.execute.call_args_list if "NULLIF" in c[0][0]]

    def test_a_recomputed_zero_is_written_back(self):
        # Mutation caught: restoring `if cost <= 0: continue`, which leaves the earlier
        # inflated cost in place forever.
        updates = self._run(
            [
                _row("root", None, "EVALUATION", None),
                _row("scorer", "root", "SCORER", None),
                _row("judge-llm", "scorer", "LLM", 0.90),
            ]
        )
        assert len(updates) == 1, "a recomputed 0.0 must still issue the UPDATE"
        sql, params = updates[0][0]
        assert "NULLIF" in sql, "0 must land as NULL, not a misleading 0.00"
        assert params[0] == pytest.approx(0.0)

    def test_a_positive_cost_is_written(self):
        updates = self._run(
            [
                _row("root", None, "EVALUATION", None),
                _row("task-llm", "root", "LLM", 0.10),
            ]
        )
        assert len(updates) == 1
        assert updates[0][0][1][0] == pytest.approx(0.10)

    def test_every_metric_rides_the_same_statement_and_the_same_nullif(self):
        """One UPDATE, so all six settle together under one `cost_derived_at` stamp —
        and each is NULLIF'd, so "no model call" reads NULL rather than a hard 0."""
        updates = self._run(
            [
                _row("root", None, "EVALUATION", None),
                _row("task-llm", "root", "LLM", 0.10, tokens=(18, 29, 47), ms=1060),
            ]
        )
        assert len(updates) == 1, "the metrics must not fan out into extra statements"
        sql, params = updates[0][0]
        for column in (
            "cost",
            "prompt_tokens",
            "completion_tokens",
            "total_tokens",
            "llm_calls",
            "llm_duration_ms",
        ):
            assert f"{column} = NULLIF(" in sql, column
        # cost, prompt, completion, total, calls, duration, then project_id + trace_id.
        assert params[:6] == (pytest.approx(0.10), 18, 29, 47, 1, 1060)

    def test_a_recomputed_zero_clears_every_metric_not_just_cost(self):
        """The two-way correction has to apply to tokens too: the batch that finally
        brings the SCORER must be able to walk an inflated token count back down."""
        updates = self._run(
            [
                _row("root", None, "EVALUATION", None),
                _row("scorer", "root", "SCORER", None),
                _row("judge-llm", "scorer", "LLM", 0.90, tokens=(900, 900, 1800), ms=5000),
            ]
        )
        assert len(updates) == 1
        assert updates[0][0][1][:6] == (pytest.approx(0.0), 0, 0, 0, 0, 0)


class TestOrdinaryIngestDoesNotTouchPostgres:
    """Every span-bearing batch for every project used to pay a fresh Postgres connect +
    query before it knew whether the batch contained any evaluation spans at all."""

    @pytest.fixture(autouse=True)
    def _no_detectors(self, monkeypatch):
        monkeypatch.setattr("worker.detector_tasks.enqueue_detector_runs", MagicMock())

    def _process(self, monkeypatch, payload):
        s3, ch = MagicMock(), MagicMock()
        s3.download_json.return_value = payload
        monkeypatch.setattr("rest.services.s3.get_s3_service", lambda: s3)
        monkeypatch.setattr("db.clickhouse.client.get_clickhouse_client", lambda: ch)
        derive = MagicMock()
        monkeypatch.setattr("worker.ingest_tasks._update_eval_result_costs", derive)
        process_s3_traces(s3_key="k.json", project_id="proj-1")
        return derive

    def test_a_batch_with_no_evaluation_spans_skips_the_derivation(self, monkeypatch):
        # Mutation caught: calling _update_eval_result_costs unconditionally.
        derive = self._process(
            monkeypatch, make_otel_payload([make_span("aa" * 16, "bb" * 8, name="ordinary")])
        )
        derive.assert_not_called()

    def test_a_batch_with_evaluation_spans_runs_the_derivation(self, monkeypatch):
        derive = self._process(
            monkeypatch,
            make_otel_payload(
                [
                    make_span(
                        "cc" * 16,
                        "dd" * 8,
                        attributes=[make_attr("traceroot.span.type", "EVALUATION")],
                    )
                ]
            ),
        )
        derive.assert_called_once()
        assert derive.call_args[0][1] == {"cc" * 16}
