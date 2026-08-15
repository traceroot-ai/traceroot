"""Per-result cost derived from an evaluation trace must measure the CANDIDATE only.

The load-bearing rule: a scorer can call an LLM of its own — an ``llm_judge``
self-instruments its model call, and a hand-rolled ``@scorer`` may call a provider
directly — and that LLM span lands in the SAME trace, nested under the SCORER span.
Folding it into the result over-reports what the candidate cost to run, so the whole
scorer subtree is dropped before summing.

`rows` mirror the ClickHouse projection the worker queries:
``(trace_id, span_id, parent_span_id, span_kind, cost)``.
"""

from unittest.mock import MagicMock, patch

import pytest

from tests.fixtures.otel_payloads import make_attr, make_otel_payload, make_span
from worker.ingest_tasks import _task_cost_by_trace, _update_eval_result_costs, process_s3_traces

T = "trace-1"


def _row(span_id, parent, kind, cost):
    return (T, span_id, parent, kind, cost)


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
        assert _task_cost_by_trace(rows) == {T: pytest.approx(0.10)}

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
        assert _task_cost_by_trace(rows) == {T: pytest.approx(0.25)}

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
        assert _task_cost_by_trace(rows) == {T: pytest.approx(0.40)}

    def test_a_scorer_carrying_cost_itself_is_excluded(self):
        rows = [
            _row("root", None, "EVALUATION", None),
            _row("task-llm", "root", "LLM", 0.10),
            _row("scorer", "root", "SCORER", 7.00),
        ]
        assert _task_cost_by_trace(rows) == {T: pytest.approx(0.10)}


class TestSummingContract:
    def test_none_costs_are_absent_not_zero_and_total_is_zero(self):
        rows = [
            _row("root", None, "EVALUATION", None),
            _row("task", "root", "TASK", None),
            _row("task-llm", "task", "LLM", None),
        ]
        assert _task_cost_by_trace(rows) == {T: 0.0}

    def test_a_span_whose_parent_is_absent_is_still_summed(self):
        """Tolerated by design — an orphan is unreachable for exclusion, but dropping it
        would silently under-report. The two-way recompute corrects it once the parent
        lands."""
        rows = [
            _row("root", None, "EVALUATION", None),
            _row("orphan-llm", "missing-parent", "LLM", 0.30),
        ]
        assert _task_cost_by_trace(rows) == {T: pytest.approx(0.30)}

    def test_multiple_traces_in_one_batch_do_not_bleed_into_each_other(self):
        rows = [
            ("trace-a", "root-a", None, "EVALUATION", None),
            ("trace-a", "llm-a", "root-a", "LLM", 0.10),
            ("trace-a", "scorer-a", "root-a", "SCORER", None),
            ("trace-a", "judge-a", "scorer-a", "LLM", 9.00),
            ("trace-b", "root-b", None, "EVALUATION", None),
            ("trace-b", "llm-b", "root-b", "LLM", 0.20),
        ]
        assert _task_cost_by_trace(rows) == {
            "trace-a": pytest.approx(0.10),
            "trace-b": pytest.approx(0.20),
        }


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
        return [c for c in cur.execute.call_args_list if "UPDATE" in c[0][0]]

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
