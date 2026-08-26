"""Cross-surface evaluation journey — one real SDK-shaped payload, end to end.

Unlike the per-surface unit tests (transform / trace-reader / detector), this drives
ONE evaluation trace — built with the same attribute shape the Python SDK emits
(``tests.fixtures.otel_payloads.make_eval_trace``) — through every backend surface it
crosses, so the surfaces are proven to agree on the *same* classification value:

1. The SDK reports an evaluation run          → make_eval_trace(...) payload
2. The backend records it as an eval trace     → transform → is_evaluation=1
3. It is excluded from normal trace browsing   → list_traces() default predicate
4. It appears when eval traces are requested   → list_traces(include_evaluations=True)
5. Detectors skip it by default                → _detector_runs_on_trace(...) is False
6. The eval result resolves to the real trace  → identity available on the trace record
7. Dataset + candidate identity are readable   → identity survives into span metadata
8. Native dataset JSON values retain types     → covered by the dataset round-trip
   exerciser (frontend eval-dataset-sync.exerciser.test.ts) — the dataset payload is a
   separate control-plane surface, proven there against the same native-JSON contract.

Placed under tests/ (CI-collected) on purpose: the detector predicate's own tests live
in backend/worker/tests/, which is outside `testpaths`, so this is the CI-covered proof
that the transformer's classification is exactly what the detector gate skips.
"""

import json
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

from tests.fixtures.otel_payloads import make_eval_trace
from worker.detector_tasks import _detector_runs_on_trace
from worker.otel_transform import transform_otel_to_clickhouse

TRACE_HEX = "ab" * 16


def _ingest():
    """Step 1→2: an SDK-shaped evaluation run, transformed as the worker would."""
    payload = make_eval_trace(TRACE_HEX)
    traces, spans = transform_otel_to_clickhouse(payload, "proj-eval")
    return traces, spans


class TestEvaluationJourney:
    def test_backend_records_it_as_an_evaluation_trace(self):
        """Step 2: the root classifies the trace as evaluation and the EVALUATION/TASK/
        SCORER span kinds are all preserved (not coerced to SPAN)."""
        traces, spans = _ingest()
        assert len(traces) == 1
        assert traces[0]["is_evaluation"] is True

        kinds = {s["name"]: s["span_kind"] for s in spans}
        assert kinds["evaluation-item"] == "EVALUATION"
        assert kinds["task"] == "TASK"
        assert kinds["helpfulness"] == "SCORER"

    def test_detector_skips_the_evaluation_trace_by_default(self):
        """Step 5: the SAME flag the transformer set is what the detector gate skips —
        and an explicit opt-in re-enables it. Keyed on `is_evaluation`, never on
        `environment`: a customer may legitimately name their environment "evaluation",
        and that must not silence their production detectors."""
        traces, _ = _ingest()
        summary = {"is_evaluation": traces[0]["is_evaluation"]}

        assert _detector_runs_on_trace(summary, {"id": "d1"}) is False
        assert _detector_runs_on_trace(summary, {"id": "d1", "run_on_evaluation": True}) is True

    def test_dataset_and_candidate_identity_are_readable(self):
        """Steps 6+7: the identity a result needs to resolve to and render its real
        trace (run + dataset/version + candidate + case + provenance) survives ingestion
        onto the root span, retrievable via the on-demand per-span metadata."""
        _, spans = _ingest()
        root = next(s for s in spans if s["name"] == "evaluation-item")
        meta = json.loads(root["metadata"])

        assert meta["traceroot.eval.run_id"] == "run_platform_1"
        assert meta["traceroot.eval.local_run_id"] == "run_01JLOCALULID"
        assert meta["traceroot.eval.dataset_id"] == "ds_1"
        assert meta["traceroot.eval.dataset_version_id"] == "dsv_1"
        assert meta["traceroot.eval.candidate_version"] == "cand_42"
        assert meta["traceroot.eval.case_id"] == "tc_1"
        assert meta["traceroot.eval.source_trace_id"] == "tr_src_1"
        assert meta["traceroot.eval.source_span_id"] == "sp_src_1"


# --- Steps 3+4: the reader's default/opt-in filter keys on the same value ---


def _make_service(query_side_effect):
    from rest.services.trace_reader import TraceReaderService

    client = MagicMock()
    client.query.side_effect = query_side_effect
    with patch("rest.services.trace_reader.get_clickhouse_client", return_value=client):
        service = TraceReaderService()
    return service, client


class TestEvaluationBrowsingSeparation:
    """Step 3+4: default browsing excludes is_evaluation traces; requesting eval traces
    drops the predicate. Binds the reader's filter to the SAME flag ingestion sets
    (asserted in TestEvaluationJourney) — never to `environment`, which is
    user-controlled free text a customer may legitimately set to "evaluation"."""

    def _run(self, **kwargs):
        # Confirm the flag the reader excludes on is exactly what ingestion produced.
        traces, _ = _ingest()
        assert traces[0]["is_evaluation"] is True

        queries: list[str] = []
        params_seen: list[dict] = []

        def side_effect(query, parameters=None, **kwargs):
            queries.append(query)
            params_seen.append(parameters or {})
            if "count()" in query:
                return SimpleNamespace(result_rows=[(0,)])
            return SimpleNamespace(result_rows=[])

        service, _ = _make_service(side_effect)
        service.list_traces("proj-eval", **kwargs)
        return queries, params_seen

    def test_excluded_from_normal_browsing_by_default(self):
        queries, _params = self._run()
        assert any("is_evaluation = 1" in q for q in queries)
        # Set-membership, not a per-row column read: a later batch that rewrites the
        # trace row with is_evaluation = 0 must not un-hide the trace.
        assert all("is_evaluation = 1" in q for q in queries if "NOT IN" in q)

    def test_appears_when_evaluation_traces_are_requested(self):
        queries, _ = self._run(include_evaluations=True)
        assert all("is_evaluation = 1" not in q for q in queries)
