"""Unit tests for Celery task logic with mocked S3 + ClickHouse."""

from unittest.mock import MagicMock

import pytest

from tests.fixtures.otel_payloads import make_otel_payload, make_span
from worker.ingest_tasks import process_s3_traces

TRACE_HEX = "aa" * 16
SPAN_HEX = "bb" * 8


@pytest.fixture()
def mock_s3(monkeypatch):
    """Mock S3 service."""
    mock = MagicMock()
    monkeypatch.setattr("rest.services.s3.get_s3_service", lambda: mock)
    return mock


@pytest.fixture()
def mock_ch(monkeypatch):
    """Mock ClickHouse client."""
    mock = MagicMock()
    monkeypatch.setattr("db.clickhouse.client.get_clickhouse_client", lambda: mock)
    return mock


@pytest.fixture(autouse=True)
def mock_detector_enqueue(monkeypatch):
    """Mock the detector enqueue so tests never touch Postgres/Redis/BullMQ."""
    mock = MagicMock()
    monkeypatch.setattr("worker.detector_tasks.enqueue_detector_runs", mock)
    return mock


class TestProcessS3Traces:
    def test_happy_path(self, mock_s3, mock_ch):
        """Downloads from S3, transforms, inserts traces + spans."""
        payload = make_otel_payload([make_span(TRACE_HEX, SPAN_HEX, name="test")])
        mock_s3.download_json.return_value = payload

        result = process_s3_traces(s3_key="test/key.json", project_id="proj-1")

        mock_s3.download_json.assert_called_once_with("test/key.json")
        assert result["traces"] == 1
        assert result["spans"] == 1
        mock_ch.insert_traces_batch.assert_called_once()
        mock_ch.insert_spans_batch.assert_called_once()

    def test_empty_payload(self, mock_s3, mock_ch):
        """Empty OTEL data -> no inserts, returns zeros."""
        mock_s3.download_json.return_value = {"resourceSpans": []}

        result = process_s3_traces(s3_key="test/key.json", project_id="proj-1")

        assert result["traces"] == 0
        assert result["spans"] == 0
        mock_ch.insert_traces_batch.assert_not_called()
        mock_ch.insert_spans_batch.assert_not_called()

    def test_s3_download_fails(self, mock_s3, mock_ch):
        """S3 error -> exception raised (Celery will retry)."""
        mock_s3.download_json.side_effect = Exception("S3 error")

        with pytest.raises(Exception, match="S3 error"):
            process_s3_traces(s3_key="test/key.json", project_id="proj-1")

        mock_ch.insert_traces_batch.assert_not_called()

    def test_clickhouse_insert_fails(self, mock_s3, mock_ch):
        """CH insert error -> exception raised."""
        payload = make_otel_payload([make_span(TRACE_HEX, SPAN_HEX)])
        mock_s3.download_json.return_value = payload
        mock_ch.insert_traces_batch.side_effect = Exception("CH connection error")

        with pytest.raises(Exception, match="CH connection error"):
            process_s3_traces(s3_key="test/key.json", project_id="proj-1")

    def test_multiple_traces_and_spans(self, mock_s3, mock_ch):
        """Payload with multiple traces processes correctly."""
        trace1 = "aa" * 16
        trace2 = "bb" * 16
        payload = make_otel_payload(
            [
                make_span(trace1, "11" * 8, name="trace-1"),
                make_span(trace2, "22" * 8, name="trace-2"),
                make_span(trace1, "33" * 8, name="child", parent_span_id_hex="11" * 8),
            ]
        )
        mock_s3.download_json.return_value = payload

        result = process_s3_traces(s3_key="test/key.json", project_id="proj-1")

        assert result["traces"] == 2
        assert result["spans"] == 3

    def test_detector_enqueue_gets_only_root_bearing_traces(
        self, mock_s3, mock_ch, mock_detector_enqueue
    ):
        """Enqueue receives only the traces whose root span arrived in this batch."""
        root_trace = "aa" * 16
        late_trace = "bb" * 16
        payload = make_otel_payload(
            [
                make_span(root_trace, "11" * 8, name="root"),
                # Child-only span for another trace — no root in this batch.
                make_span(late_trace, "22" * 8, name="child", parent_span_id_hex="33" * 8),
            ]
        )
        mock_s3.download_json.return_value = payload
        mock_ch.query.return_value = MagicMock(result_rows=[])

        process_s3_traces(s3_key="test/key.json", project_id="proj-1")

        mock_detector_enqueue.assert_called_once()
        project_id, traces_with_root = mock_detector_enqueue.call_args[0]
        assert project_id == "proj-1"
        # Only the root-bearing trace is passed; the child-only late_trace is not.
        assert traces_with_root == {root_trace}

    def test_detector_enqueue_not_called_for_empty_batch(
        self, mock_s3, mock_ch, mock_detector_enqueue
    ):
        mock_s3.download_json.return_value = {"resourceSpans": []}

        process_s3_traces(s3_key="test/key.json", project_id="proj-1")

        mock_detector_enqueue.assert_not_called()


class TestTaskCostByTrace:
    """`_task_cost_by_trace` scopes derived eval cost to the CANDIDATE TASK, excluding
    the scorer subtree (an llm_judge or a code scorer that calls an LLM shares the trace).
    Rows are (trace_id, span_id, parent_span_id, span_kind, cost)."""

    def test_excludes_scorer_llm_cost(self):
        from worker.ingest_tasks import _task_cost_by_trace

        rows = [
            ("t1", "root", "", "EVALUATION", None),
            ("t1", "task", "root", "TASK", None),
            ("t1", "task_llm", "task", "LLM", 0.010),  # candidate cost
            ("t1", "scorer", "root", "SCORER", None),
            ("t1", "judge_llm", "scorer", "LLM", 0.004),  # judge cost — excluded
        ]
        assert _task_cost_by_trace(rows) == {"t1": pytest.approx(0.010)}

    def test_excludes_deeply_nested_scorer_descendants(self):
        from worker.ingest_tasks import _task_cost_by_trace

        # Scorer -> wrapper span -> LLM: the whole subtree is excluded, not just direct children.
        rows = [
            ("t1", "task", "root", "TASK", None),
            ("t1", "task_llm", "task", "LLM", 0.02),
            ("t1", "scorer", "root", "SCORER", None),
            ("t1", "wrap", "scorer", "SPAN", None),
            ("t1", "judge_llm", "wrap", "LLM", 0.05),
        ]
        assert _task_cost_by_trace(rows) == {"t1": pytest.approx(0.02)}

    def test_no_scorer_llm_sums_all_task_cost(self):
        from worker.ingest_tasks import _task_cost_by_trace

        # A trivial code scorer (no LLM) — nothing to exclude; two task LLM calls sum.
        rows = [
            ("t1", "task", "root", "TASK", None),
            ("t1", "llm_a", "task", "LLM", 0.003),
            ("t1", "llm_b", "task", "LLM", 0.004),
            ("t1", "scorer", "root", "SCORER", None),
        ]
        assert _task_cost_by_trace(rows) == {"t1": pytest.approx(0.007)}

    def test_costless_trace_is_zero(self):
        from worker.ingest_tasks import _task_cost_by_trace

        rows = [
            ("t1", "root", "", "EVALUATION", None),
            ("t1", "task", "root", "TASK", None),
        ]
        assert _task_cost_by_trace(rows) == {"t1": 0.0}

    def test_multiple_traces_kept_separate(self):
        from worker.ingest_tasks import _task_cost_by_trace

        rows = [
            ("t1", "task1", "root1", "TASK", None),
            ("t1", "llm1", "task1", "LLM", 0.01),
            ("t2", "task2", "root2", "TASK", None),
            ("t2", "llm2", "task2", "LLM", 0.02),
            ("t2", "scorer2", "root2", "SCORER", None),
            ("t2", "judge2", "scorer2", "LLM", 0.99),
        ]
        assert _task_cost_by_trace(rows) == {
            "t1": pytest.approx(0.01),
            "t2": pytest.approx(0.02),
        }


class FakeCursor:
    """Records every `execute()` call and answers `fetchall()` from a canned
    result, so a test can assert on exactly which statements were issued."""

    def __init__(self, fetchall_result):
        self._fetchall_result = fetchall_result
        self.executed: list[tuple[str, tuple]] = []

    def execute(self, sql, params=None):
        self.executed.append((sql, params))

    def fetchall(self):
        return self._fetchall_result

    def __enter__(self):
        return self

    def __exit__(self, *exc_info):
        return False


class FakeConnection:
    def __init__(self, cursor):
        self._cursor = cursor
        self.committed = False
        self.closed = False
        self.rolled_back = False

    def cursor(self):
        return self._cursor

    def commit(self):
        self.committed = True

    def rollback(self):
        self.rolled_back = True

    def close(self):
        self.closed = True


class FakePool:
    """Stands in for the module-level ThreadedConnectionPool: hands out one connection
    and records that it was handed back (putconn), not closed."""

    def __init__(self, conn):
        self._conn = conn
        self.returned = False

    def getconn(self):
        return self._conn

    def putconn(self, conn):
        assert conn is self._conn
        self.returned = True


class TestUpdateEvalResultCosts:
    """`_update_eval_result_costs` denormalizes derived cost onto `evaluation_results`
    for a costed trace, and per the module's own docstring — "never writes 0 (a
    cost-less trace leaves `cost` NULL)" — must issue no UPDATE at all for a
    cost-less trace. That second half had zero coverage: nothing under `tests/`
    drove this function at all."""

    def _patch_connect(self, monkeypatch, cursor):
        pool = FakePool(FakeConnection(cursor))
        monkeypatch.setattr("worker.ingest_tasks._get_pg_pool", lambda: pool)
        return pool

    def test_writes_every_eval_trace_and_nullifs_the_costless_one(self, monkeypatch):
        """The write is UNCONDITIONAL — a zero total is still written, as NULLIF.

        Skipping the write when the recomputed total is 0 would freeze a transient
        over-report permanently: under ``BatchSpanProcessor`` a scorer's LLM child can
        land in an earlier batch than the SCORER span that excludes it, so the total is
        briefly too high and only a later batch corrects it downward. See the rationale
        on ``_update_eval_result_costs``. ``NULLIF(%s, 0)`` is what keeps a genuinely
        cost-less trace's ``cost`` NULL rather than a misleading 0.
        """
        from worker.ingest_tasks import _update_eval_result_costs

        # Both traces are eval results (the scoping query returns both); only
        # "t-costed" has any non-scorer LLM cost, "t-zero" has none.
        cursor = FakeCursor(fetchall_result=[("t-costed",), ("t-zero",)])
        pool = self._patch_connect(monkeypatch, cursor)

        mock_ch = MagicMock()
        mock_ch.query.return_value = MagicMock(
            result_rows=[
                ("t-costed", "task", "root", "TASK", None),
                ("t-costed", "llm", "task", "LLM", 0.02),
                ("t-zero", "task", "root", "TASK", None),
            ]
        )

        _update_eval_result_costs("proj-1", {"t-costed", "t-zero"}, mock_ch)

        updates = [
            (sql, params) for sql, params in cursor.executed if sql.strip().startswith("UPDATE")
        ]
        assert len(updates) == 2
        by_trace = {params[2]: (sql, params) for sql, params in updates}
        assert set(by_trace) == {"t-costed", "t-zero"}
        for sql, _ in updates:
            assert "evaluation_results" in sql
            # NULLIF is what makes the unconditional write safe for a cost-less trace.
            assert "NULLIF" in sql
        assert by_trace["t-costed"][1] == (pytest.approx(0.02), "proj-1", "t-costed")
        assert by_trace["t-zero"][1] == (pytest.approx(0.0), "proj-1", "t-zero")
        assert pool._conn.committed is True
        # Pooled: the connection is returned to the pool (putconn), not closed (M17).
        assert pool.returned is True
        assert pool._conn.closed is False

    def test_no_eval_trace_ids_skips_clickhouse_and_updates(self, monkeypatch):
        """The scoping query (trace_id must belong to `evaluation_results`) returning
        nothing means the batch had no eval traces at all — bail before ever calling
        ClickHouse or issuing an UPDATE."""
        from worker.ingest_tasks import _update_eval_result_costs

        cursor = FakeCursor(fetchall_result=[])
        self._patch_connect(monkeypatch, cursor)
        mock_ch = MagicMock()

        _update_eval_result_costs("proj-1", {"t-not-an-eval"}, mock_ch)

        mock_ch.query.assert_not_called()
        assert not any(sql.strip().startswith("UPDATE") for sql, _ in cursor.executed)

    def test_backfill_reconciles_null_cost_results_grouped_by_project(self, monkeypatch):
        """The periodic sweep (H7) re-derives cost for recent null-cost results grouped by
        project — catching a result row that committed after its spans were processed and
        so was never revisited by span-ingest."""
        from worker import ingest_tasks

        cursor = FakeCursor(fetchall_result=[("p1", "t1"), ("p1", "t2"), ("p2", "t3")])
        self._patch_connect(monkeypatch, cursor)

        calls: list = []
        monkeypatch.setattr(
            ingest_tasks,
            "_update_eval_result_costs",
            lambda project_id, trace_ids, ch: calls.append((project_id, set(trace_ids))),
        )
        monkeypatch.setattr("db.clickhouse.client.get_clickhouse_client", lambda: MagicMock())

        out = ingest_tasks.backfill_eval_result_costs(batch_size=10)

        assert out == {"projects": 2, "traces": 3}
        assert dict(calls) == {"p1": {"t1", "t2"}, "p2": {"t3"}}
        # Only recent rows are swept (bounded window, so it converges).
        select_sql = next(sql for sql, _ in cursor.executed if sql.strip().startswith("SELECT"))
        assert "cost IS NULL" in select_sql
        assert "create_time >" in select_sql

    def test_backfill_no_null_cost_results_is_a_noop(self, monkeypatch):
        from worker import ingest_tasks

        self._patch_connect(monkeypatch, FakeCursor(fetchall_result=[]))
        called: list = []
        monkeypatch.setattr(
            ingest_tasks, "_update_eval_result_costs", lambda *a, **k: called.append(1)
        )

        assert ingest_tasks.backfill_eval_result_costs() == {"projects": 0, "traces": 0}
        assert called == []
