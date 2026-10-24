"""Unit tests for Celery task logic with mocked S3 + ClickHouse."""

from datetime import datetime, timedelta
from unittest.mock import MagicMock

import pytest

from tests.fixtures.otel_payloads import make_otel_payload, make_span
from worker.ingest_tasks import _merge_trace_record, process_s3_traces
from worker.otel_transform import PARENT_IS_REMOTE_KEY

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


@pytest.fixture(autouse=True)
def mock_remote_detector_finalization(monkeypatch):
    """Keep unit tests at the scheduling boundary without requiring Redis."""
    mock = MagicMock()
    monkeypatch.setattr("worker.detector_tasks.schedule_remote_detector_finalization", mock)
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

    def test_missing_root_probe_is_scoped_to_the_project(self, mock_s3, mock_ch):
        """The probe names project_id, the sort-key prefix it needs to prune on."""
        late_trace = "cc" * 16
        mock_s3.download_json.return_value = make_otel_payload(
            [make_span(late_trace, "44" * 8, name="child", parent_span_id_hex="55" * 8)]
        )
        mock_ch.query.return_value = MagicMock(result_rows=[])

        process_s3_traces(s3_key="test/key.json", project_id="proj-1")

        args, kwargs = mock_ch.query.call_args
        assert "project_id" in args[0]
        assert kwargs["parameters"]["project_id"] == "proj-1"

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
    def __init__(self, cursor, rollback_raises=False):
        self._cursor = cursor
        self.committed = False
        self.closed = False
        self.rolled_back = False
        # A connection that has already died can raise from rollback() itself — the
        # error path must survive that and still evict the connection.
        self._rollback_raises = rollback_raises

    def cursor(self):
        return self._cursor

    def commit(self):
        self.committed = True

    def rollback(self):
        self.rolled_back = True
        if self._rollback_raises:
            raise Exception("connection already dead")

    def close(self):
        self.closed = True


class FakePool:
    """Stands in for the module-level ThreadedConnectionPool: hands out one connection
    and records how it was handed back — `returned` (putconn) and whether it was evicted
    (`close=True`, which the real pool discards instead of recycling)."""

    def __init__(self, conn):
        self._conn = conn
        self.returned = False
        self.closed_on_return = None

    def getconn(self):
        return self._conn

    def putconn(self, conn, close=False):
        assert conn is self._conn
        self.returned = True
        self.closed_on_return = close
        if close:
            conn.close()


class TestUpdateEvalResultCosts:
    """`_update_eval_result_costs` denormalizes derived cost onto `evaluation_results`.
    The write is UNCONDITIONAL — a cost-less trace is written via `NULLIF(..., 0)` (kept
    NULL, not 0) rather than skipped — and every examined row is stamped
    `cost_derived_at` so the backfill can tell derived-to-NULL from not-yet-derived."""

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
        # Two per-trace cost writes (NULLIF) ...
        cost_updates = [(sql, params) for sql, params in updates if "NULLIF" in sql]
        assert len(cost_updates) == 2
        by_trace = {params[2]: (sql, params) for sql, params in cost_updates}
        assert set(by_trace) == {"t-costed", "t-zero"}
        for sql, _ in cost_updates:
            assert "evaluation_results" in sql
        assert by_trace["t-costed"][1] == (pytest.approx(0.02), "proj-1", "t-costed")
        assert by_trace["t-zero"][1] == (pytest.approx(0.0), "proj-1", "t-zero")
        # ... plus ONE derivation-attempted stamp covering every examined result row,
        # so the zero-cost trace settles instead of being re-swept by the backfill forever.
        marking = [(sql, params) for sql, params in updates if "cost_derived_at" in sql]
        assert len(marking) == 1
        _, mark_params = marking[0]
        assert mark_params[0] == "proj-1"
        assert set(mark_params[1]) == {"t-costed", "t-zero"}
        assert pool._conn.committed is True
        # A clean run recycles the connection (putconn without close), never evicts it.
        assert pool.returned is True
        assert pool.closed_on_return is False
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

    def test_broken_connection_is_evicted_not_recycled(self, monkeypatch):
        """When the work fails AND rollback() itself throws (a connection that has already
        died), the error is swallowed and the poisoned connection is CLOSED on the way back
        — never recycled into the pool for the next borrower to trip over."""
        from worker.ingest_tasks import _update_eval_result_costs

        cursor = FakeCursor(fetchall_result=[("t1",)])
        conn = FakeConnection(cursor, rollback_raises=True)
        pool = FakePool(conn)
        monkeypatch.setattr("worker.ingest_tasks._get_pg_pool", lambda: pool)

        # Blow up mid-work (after the scoping query) so the except path runs.
        mock_ch = MagicMock()
        mock_ch.query.side_effect = Exception("clickhouse down")

        # A throwing rollback() must not escape this call.
        _update_eval_result_costs("proj-1", {"t1"}, mock_ch)

        assert conn.rolled_back is True  # rollback was attempted (and it raised)...
        assert pool.returned is True  # ... yet the connection was still handed back ...
        assert pool.closed_on_return is True  # ... and evicted, not recycled.
        assert conn.closed is True

    def test_backfill_reconciles_null_cost_results_grouped_by_project(self, monkeypatch):
        """The periodic sweep re-derives cost for recent null-cost results grouped by
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
        select_sql = next(sql for sql, _ in cursor.executed if sql.strip().startswith("SELECT"))
        # Candidates are NOT-YET-DERIVED (cost_derived_at IS NULL), not cost IS NULL —
        # so an already-derived zero-cost row can't be re-swept forever.
        assert "cost_derived_at IS NULL" in select_sql
        assert "cost IS NULL" not in select_sql
        # Bounded window + newest-first ordering: converges, and no late row is starved.
        assert "create_time >" in select_sql
        assert "ORDER BY create_time DESC" in select_sql

    def test_backfill_no_null_cost_results_is_a_noop(self, monkeypatch):
        from worker import ingest_tasks

        self._patch_connect(monkeypatch, FakeCursor(fetchall_result=[]))
        called: list = []
        monkeypatch.setattr(
            ingest_tasks, "_update_eval_result_costs", lambda *a, **k: called.append(1)
        )

        assert ingest_tasks.backfill_eval_result_costs() == {"projects": 0, "traces": 0}
        assert called == []


class TestRemoteParentEntrySpans:
    """Ingest gating for true local roots vs remote-parent entries (W3C traceparent)."""

    TRACE_HEX = "cc" * 16
    ENTRY_SPAN_HEX = "11" * 8
    REMOTE_PARENT_HEX = "22" * 8
    TRUE_ROOT_HEX = "33" * 8

    @pytest.fixture(autouse=True)
    def skip_live_publish(self, monkeypatch):
        """Spans here carry traceroot.span.input/output, which triggers the live
        Redis publish; skip it so these tests never dial localhost:6379."""
        mock = MagicMock()
        monkeypatch.setattr("worker.ingest_tasks._publish_live_spans", mock)
        return mock

    def _entry_batch(self) -> dict:
        payload = make_otel_payload(
            [
                make_span(
                    self.TRACE_HEX,
                    self.ENTRY_SPAN_HEX,
                    name="handle_request",
                    parent_span_id_hex=self.REMOTE_PARENT_HEX,
                    attributes=[
                        {"key": "traceroot.span.input", "value": {"stringValue": "user input"}},
                        {
                            "key": "traceroot.span.output",
                            "value": {"stringValue": "user output"},
                        },
                        {"key": "traceroot.trace.metadata", "value": {"stringValue": "{}"}},
                    ],
                    flags=768,
                )
            ]
        )
        return payload

    def _true_root_batch(self) -> dict:
        return make_otel_payload([make_span(self.TRACE_HEX, self.TRUE_ROOT_HEX, name="agent-run")])

    def _stored_trace_row(self, *, root_kind: int = 1) -> tuple:
        """Return the shape selected by ``_trace_rows_by_id``."""
        from shared.trace_identity import trace_root_version

        start = datetime(2024, 1, 15, 12, 0)
        return (
            self.TRACE_HEX,
            root_kind,
            trace_root_version(root_kind, start),
            start,
            "handle_request" if root_kind == 1 else "agent-run",
            "user",
            None,
            None,
            None,
            None,
            "user input" if root_kind == 1 else None,
            "user output" if root_kind == 1 else None,
            "{}" if root_kind == 1 else None,
            None,
            0,
        )

    def test_remote_entry_batch_inserts_trace_and_defers_detector_claim(
        self,
        mock_s3,
        mock_ch,
        mock_detector_enqueue,
        mock_remote_detector_finalization,
        skip_live_publish,
    ):
        """A flagged batch inserts provisional identity and defers detection."""
        mock_s3.download_json.return_value = self._entry_batch()
        mock_ch.query.return_value = MagicMock(result_rows=[])

        result = process_s3_traces(s3_key="test/key.json", project_id="proj-1")

        assert (result["traces"], result["spans"]) == (1, 1)
        (inserted,) = mock_ch.insert_traces_batch.call_args[0][0]
        assert inserted["name"] == "handle_request"
        assert inserted["input"] == "user input"  # full root-upgrade row, not a placeholder
        mock_ch.insert_spans_batch.assert_called_once()
        mock_detector_enqueue.assert_not_called()
        mock_remote_detector_finalization.assert_called_once_with("proj-1", {self.TRACE_HEX})
        published_spans = skip_live_publish.call_args.args[0]
        assert PARENT_IS_REMOTE_KEY not in published_spans[0]

    def test_established_root_blocks_the_remote_batch_from_replanting(
        self, mock_s3, mock_ch, mock_detector_enqueue, mock_remote_detector_finalization
    ):
        """A stored true root wins; the remote batch cannot downgrade it."""
        mock_s3.download_json.return_value = self._entry_batch()
        mock_ch.query.return_value = MagicMock(result_rows=[self._stored_trace_row(root_kind=2)])

        process_s3_traces(s3_key="test/key.json", project_id="proj-1")

        mock_ch.insert_traces_batch.assert_not_called()
        mock_ch.insert_spans_batch.assert_called_once()
        mock_detector_enqueue.assert_not_called()
        mock_remote_detector_finalization.assert_called_once_with("proj-1", {self.TRACE_HEX})

    def test_true_root_batch_still_replaces_an_existing_row(
        self, mock_s3, mock_ch, mock_detector_enqueue
    ):
        """A true local root remains eligible for the final detector claim."""
        payload = make_otel_payload(
            [
                make_span(self.TRACE_HEX, self.TRUE_ROOT_HEX, name="agent-run"),
                make_span(
                    self.TRACE_HEX,
                    self.ENTRY_SPAN_HEX,
                    name="llm-call",
                    parent_span_id_hex=self.TRUE_ROOT_HEX,
                ),
            ]
        )
        mock_s3.download_json.return_value = payload

        process_s3_traces(s3_key="test/key.json", project_id="proj-1")

        mock_ch.query.assert_called_once()
        mock_ch.insert_traces_batch.assert_called_once()
        mock_detector_enqueue.assert_called_once()
        _project_id, traces_with_root = mock_detector_enqueue.call_args[0]
        assert traces_with_root == {self.TRACE_HEX}

    def test_true_root_lands_after_the_remote_batch_and_wins(
        self, mock_s3, mock_ch, mock_detector_enqueue, mock_remote_detector_finalization
    ):
        """Remote batch first (new trace → its row), true-root batch second → row is replaced
        with the true root's identity. Arrival order must not matter."""
        mock_ch.query.side_effect = [
            MagicMock(result_rows=[]),
            MagicMock(result_rows=[self._stored_trace_row()]),
        ]

        mock_s3.download_json.return_value = self._entry_batch()
        process_s3_traces(s3_key="test/1.json", project_id="proj-1")
        first_row = mock_ch.insert_traces_batch.call_args_list[0][0][0][0]
        assert first_row["name"] == "handle_request"

        mock_s3.download_json.return_value = self._true_root_batch()
        process_s3_traces(s3_key="test/2.json", project_id="proj-1")
        second_row = mock_ch.insert_traces_batch.call_args_list[1][0][0][0]
        assert second_row["name"] == "agent-run"
        assert mock_detector_enqueue.call_count == 1
        mock_detector_enqueue.assert_called_once_with("proj-1", {self.TRACE_HEX})
        mock_remote_detector_finalization.assert_called_once_with("proj-1", {self.TRACE_HEX})

    def test_remote_batch_after_true_root_does_not_claim_again(
        self, mock_s3, mock_ch, mock_detector_enqueue, mock_remote_detector_finalization
    ):
        """Caller-first and callee-second delivery keeps one final detector claim."""
        mock_ch.query.side_effect = [
            MagicMock(result_rows=[]),
            MagicMock(result_rows=[self._stored_trace_row(root_kind=2)]),
        ]

        mock_s3.download_json.return_value = self._true_root_batch()
        process_s3_traces(s3_key="test/caller.json", project_id="proj-1")
        mock_s3.download_json.return_value = self._entry_batch()
        process_s3_traces(s3_key="test/callee.json", project_id="proj-1")

        mock_detector_enqueue.assert_called_once_with("proj-1", {self.TRACE_HEX})
        mock_remote_detector_finalization.assert_called_once_with("proj-1", {self.TRACE_HEX})
        assert mock_ch.insert_traces_batch.call_count == 1

    def test_replayed_remote_batch_writes_spans_again_but_not_the_row(
        self, mock_s3, mock_ch, mock_remote_detector_finalization
    ):
        """Delivery retry writes spans again but leaves row replacement and claim dedup safe."""
        mock_ch.query.return_value = MagicMock(result_rows=[])
        mock_s3.download_json.return_value = self._entry_batch()

        process_s3_traces(s3_key="test/key.json", project_id="proj-1")
        mock_ch.query.return_value = MagicMock(result_rows=[self._stored_trace_row()])
        process_s3_traces(s3_key="test/key.json", project_id="proj-1")

        inserts = mock_ch.insert_traces_batch.call_args_list
        assert len(inserts) == 1
        assert mock_ch.insert_spans_batch.call_count == 2
        assert mock_remote_detector_finalization.call_count == 2

    def test_late_children_of_a_remote_root_enqueue_nothing(
        self, mock_s3, mock_ch, mock_detector_enqueue
    ):
        """Children exported in a later batch: no second detection trigger for the trace."""
        children_batch = make_otel_payload(
            [
                make_span(
                    self.TRACE_HEX,
                    "44" * 8,
                    name="llm-call",
                    parent_span_id_hex=self.ENTRY_SPAN_HEX,
                )
            ]
        )
        mock_ch.query.return_value = MagicMock(result_rows=[self._stored_trace_row()])
        mock_s3.download_json.return_value = children_batch

        process_s3_traces(s3_key="test/later-children.json", project_id="proj-1")

        mock_detector_enqueue.assert_not_called()

    def test_remote_root_and_true_root_of_different_traces_in_one_batch(
        self, mock_s3, mock_ch, mock_detector_enqueue, mock_remote_detector_finalization
    ):
        """Cross-trace isolation: each trace's row and trigger treatment stay its own."""
        other_hex = "dd" * 16
        mixed = make_otel_payload(
            [
                make_span(
                    self.TRACE_HEX,
                    self.ENTRY_SPAN_HEX,
                    name="handle_request",
                    parent_span_id_hex=self.REMOTE_PARENT_HEX,
                    flags=768,
                ),
                make_span(other_hex, "55" * 8, name="other-root"),
            ]
        )
        mock_s3.download_json.return_value = mixed
        mock_ch.query.return_value = MagicMock(result_rows=[])

        process_s3_traces(s3_key="test/key.json", project_id="proj-1")

        inserted = mock_ch.insert_traces_batch.call_args[0][0]
        names = {row["trace_id"]: row["name"] for row in inserted}
        assert names == {self.TRACE_HEX: "handle_request", other_hex: "other-root"}
        mock_detector_enqueue.assert_called_once_with("proj-1", {other_hex})
        mock_remote_detector_finalization.assert_called_once_with("proj-1", {self.TRACE_HEX})
        spans_inserted = mock_ch.insert_spans_batch.call_args[0][0]
        remote_span = next(s for s in spans_inserted if s["span_id"] == self.ENTRY_SPAN_HEX)
        assert remote_span["parent_span_id"] == self.REMOTE_PARENT_HEX


class TestTraceRootMerge:
    """Replacement rows keep root identity deterministic and preserve only safe fields."""

    def _row(self, kind, start, **fields):
        from shared.trace_identity import trace_root_version

        row = {
            "trace_id": "trace-1",
            "project_id": "proj-1",
            "trace_start_time": start,
            "name": "trace",
            "root_kind": kind,
            "root_version": trace_root_version(kind, start, fields.get("is_evaluation", False)),
            "is_evaluation": int(fields.pop("is_evaluation", False)),
        }
        row.update(fields)
        return row

    def test_evaluation_and_user_session_state_are_monotonic(self):
        from datetime import datetime

        stored = self._row(
            2,
            datetime(2024, 1, 15, 12),
            is_evaluation=True,
            user_id="u-1",
            session_id="s-1",
            input="root input",
        )
        incoming = self._row(
            1,
            datetime(2024, 1, 15, 12, 1),
            user_id=None,
            session_id=None,
            input="callee input",
        )

        merged = _merge_trace_record(incoming, stored)

        assert merged["root_kind"] == 2
        assert merged["is_evaluation"] == 1
        assert merged["user_id"] == "u-1"
        assert merged["session_id"] == "s-1"
        assert merged["input"] == "root input"

    def test_winning_root_does_not_inherit_losing_root_io_or_metadata(self):
        from datetime import datetime

        stored = self._row(
            1,
            datetime(2024, 1, 15, 12, 1),
            name="callee",
            input="callee input",
            output="callee output",
            metadata='{"callee":"yes"}',
            environment="staging",
        )
        incoming = self._row(
            2,
            datetime(2024, 1, 15, 12),
            name="caller",
            environment="production",
        )

        merged = _merge_trace_record(incoming, stored)

        assert merged["name"] == "caller"
        assert "input" not in merged
        assert "output" not in merged
        assert "metadata" not in merged
        assert merged["environment"] == "production"

    def test_earlier_remote_entry_wins_regardless_of_arrival_order(self):
        from datetime import datetime

        late = self._row(
            1,
            datetime(2024, 1, 15, 12, 1),
            name="late-callee",
            input="late input",
        )
        early = self._row(
            1,
            datetime(2024, 1, 15, 12),
            name="early-callee",
            input="early input",
        )

        after_late_then_early = _merge_trace_record(early, late)
        after_early_then_late = _merge_trace_record(late, early)

        assert after_late_then_early["name"] == "early-callee"
        assert after_late_then_early["input"] == "early input"
        assert after_early_then_late["name"] == "early-callee"
        assert after_early_then_late["input"] == "early input"

    def test_root_version_treats_naive_clickhouse_time_as_utc(self):
        from datetime import UTC, datetime, timezone

        from shared.trace_identity import trace_root_version

        naive = datetime(2024, 1, 15, 12)
        aware = naive.replace(tzinfo=UTC)
        offset = aware.astimezone(timezone(timedelta(hours=5, minutes=30)))

        assert trace_root_version(1, naive) == trace_root_version(1, aware)
        assert trace_root_version(1, aware) == trace_root_version(1, offset)
