"""Offline-evaluation traces must be hidden from EVERY trace-derived read path.

The SQL half of the feature. Same harness as ``test_trace_reader_filters.py``: a mocked
ClickHouse client, asserting on the emitted query strings and bound parameters.

Three invariants are load-bearing and each has its own test below.

1. **Page/count parity.** ``list_traces``, ``list_sessions`` and ``list_users`` each run
   two physically separate statements. If the exclusion reached only the paged statement,
   ``meta.total`` would count traces the caller can never page to.

2. **Monotonicity across batches.** Ingest sets ``is_evaluation`` monotonically *within* a
   batch, but cannot do so *between* batches: a later batch carrying only non-eval-kind
   spans of an evaluation trace rewrites the trace row with ``is_evaluation = 0`` and a
   newer ``ch_update_time``. So the exclusion must NOT be a predicate over the deduped
   *latest* row (``LIMIT 1 BY`` / ``argMax``) — such a batch landing last would un-hide the
   trace. It is a trace_id set-membership instead: any row anywhere flagged 1 hides the
   trace permanently, whatever order the writes arrived in.

3. **No collision with user data.** The predicate keys off the ingest-set
   ``is_evaluation`` flag, never off ``environment``. ``environment`` is the customer's own
   free-text deployment tag, so a team that names a stack "evaluation" keeps every trace.
"""

from datetime import datetime
from unittest.mock import MagicMock

from rest.services.trace_reader import TraceReaderService

# The shape _evaluation_exclusion() emits. Asserted as a literal so a refactor that
# quietly turns it back into a latest-row comparison fails here.
EXCLUSION = "t.trace_id NOT IN (SELECT trace_id FROM traces"


def _service_with_mock_client():
    svc = TraceReaderService.__new__(TraceReaderService)  # skip real-client __init__
    svc._client = MagicMock()
    return svc


def _queries(svc):
    """(sql, parameters) for every statement the call issued, in order."""
    return [(c.args[0], c.kwargs.get("parameters", {})) for c in svc._client.query.call_args_list]


def _exclusion_subselect(sql: str) -> str:
    """The text of the ``NOT IN (...)`` sub-select, for monotonicity assertions."""
    start = sql.index(EXCLUSION)
    depth = 0
    for i in range(start, len(sql)):
        if sql[i] == "(":
            depth += 1
        elif sql[i] == ")":
            depth -= 1
            if depth == 0:
                return sql[start : i + 1]
    raise AssertionError("unbalanced parentheses in exclusion sub-select")


def _rows(*result_rows):
    """Queue up one mock result per statement the method under test will run."""
    out = []
    for rows in result_rows:
        m = MagicMock()
        m.result_rows = list(rows)
        out.append(m)
    return out


# ── list_traces ─────────────────────────────────────────────────────────


class TestListTraces:
    def test_exclusion_reaches_both_page_and_count(self):
        svc = _service_with_mock_client()
        svc._client.query.side_effect = _rows([], [[0]])

        svc.list_traces(project_id="p1")

        page_sql, _ = _queries(svc)[0]
        count_sql, _ = _queries(svc)[1]
        assert EXCLUSION in page_sql
        assert EXCLUSION in count_sql  # the parity invariant
        # ...and both exclude on the same thing, not just both mention a sub-select.
        assert "is_evaluation = 1" in _exclusion_subselect(page_sql)
        assert "is_evaluation = 1" in _exclusion_subselect(count_sql)

    def test_include_evaluations_drops_the_predicate_entirely(self):
        svc = _service_with_mock_client()
        svc._client.query.side_effect = _rows([], [[0]])

        svc.list_traces(project_id="p1", include_evaluations=True)

        for sql, _ in _queries(svc):
            assert EXCLUSION not in sql

    def test_exclusion_is_monotonic_not_a_latest_row_predicate(self):
        """The whole correctness argument. The sub-select reads EVERY row for the trace —
        no ``LIMIT 1 BY``, no ``argMax``, no ``ch_update_time`` tie-break — so a later batch
        that rewrites the trace row with ``is_evaluation = 0`` cannot un-hide it."""
        svc = _service_with_mock_client()
        svc._client.query.side_effect = _rows([], [[0]])

        svc.list_traces(project_id="p1")

        for sql, _ in _queries(svc):
            sub = _exclusion_subselect(sql)
            assert "LIMIT 1 BY" not in sub
            assert "argMax" not in sub
            assert "ch_update_time" not in sub

    def test_no_latest_row_environment_comparison_survives(self):
        """Guards against the earlier, broken formulation coming back: a NULL-safe
        comparison against the deduped row (``environment IS NULL OR environment != ...``)
        keeps exactly the shallow rows that defeat the exclusion."""
        svc = _service_with_mock_client()
        svc._client.query.side_effect = _rows([], [[0]])

        svc.list_traces(project_id="p1")

        for sql, _ in _queries(svc):
            assert "environment IS NULL" not in sql
            assert "argMax(t.environment" not in sql

    def test_a_customer_environment_named_evaluation_is_not_hidden(self):
        """REGRESSION for the data-loss bug. ``environment`` is user-controlled free text
        — a team can legitimately run ``TRACEROOT_ENVIRONMENT=evaluation`` for a pre-prod
        stack, and the filter dropdown will happily offer it next to ``production``. If
        the exclusion keyed off that string their entire Traces list would empty out with
        no in-product way back. The predicate must not mention ``environment`` at all: it
        reads the ingest-set ``is_evaluation`` flag, which a customer cannot collide with
        by naming a deployment."""
        svc = _service_with_mock_client()
        svc._client.query.side_effect = _rows([], [[0]])

        svc.list_traces(project_id="p1")

        for sql, _ in _queries(svc):
            sub = _exclusion_subselect(sql)
            # The user's deployment tag is never consulted...
            assert "environment" not in sub
            # ...the ingest-set flag is.
            assert "is_evaluation = 1" in sub

    def test_exclusion_reuses_the_callers_window(self):
        """The sub-select prunes the same monthly partitions as the outer query."""
        svc = _service_with_mock_client()
        svc._client.query.side_effect = _rows([], [[0]])

        svc.list_traces(
            project_id="p1",
            start_after=datetime(2026, 6, 1),
            end_before=datetime(2026, 6, 2),
        )

        sub = _exclusion_subselect(_queries(svc)[0][0])
        assert "start_after" in sub
        assert "end_before" in sub


# ── list_sessions ───────────────────────────────────────────────────────


class TestListSessions:
    """An eval run of 200 dataset items under one ``session_id`` must not surface in
    Sessions as a 200-trace session whose cost lands in the project's spend."""

    def test_exclusion_reaches_aggregate_and_count(self):
        svc = _service_with_mock_client()
        svc._client.query.side_effect = _rows([], [[0]])

        svc.list_sessions(project_id="p1")

        agg_sql, _ = _queries(svc)[0]
        count_sql, _ = _queries(svc)[1]
        assert EXCLUSION in agg_sql
        assert EXCLUSION in count_sql
        assert "is_evaluation = 1" in _exclusion_subselect(agg_sql)
        assert "is_evaluation = 1" in _exclusion_subselect(count_sql)

    def test_exclusion_reaches_the_io_backfill_query(self):
        """A session with empty trace-level I/O falls back to span I/O via a THIRD
        statement that builds its own traces scan — an evaluation trace must not be
        allowed to supply the session's displayed input/output through that back door."""
        svc = _service_with_mock_client()
        # One session whose trace-level I/O is empty, so the backfill fires.
        svc._client.query.side_effect = _rows(
            [("s1", 1, [], None, None, None, None, None, None, "", "")],
            [[1]],
            [],
        )

        svc.list_sessions(project_id="p1")

        sqls = [sql for sql, _ in _queries(svc)]
        assert len(sqls) == 3, "expected the I/O backfill statement to run"
        assert EXCLUSION in sqls[2]

    def test_include_evaluations_drops_the_predicate(self):
        svc = _service_with_mock_client()
        svc._client.query.side_effect = _rows([], [[0]])

        svc.list_sessions(project_id="p1", include_evaluations=True)

        for sql, _ in _queries(svc):
            assert EXCLUSION not in sql

    def test_exclusion_is_monotonic(self):
        svc = _service_with_mock_client()
        svc._client.query.side_effect = _rows([], [[0]])

        svc.list_sessions(project_id="p1")

        for sql, _ in _queries(svc):
            sub = _exclusion_subselect(sql)
            assert "LIMIT 1 BY" not in sub
            assert "ch_update_time" not in sub


# ── get_session ─────────────────────────────────────────────────────────


class TestGetSession:
    def _trace_row(self):
        return ("t1", "n", datetime(2026, 6, 1), None, "in", "out", 1.0, "ok")

    def test_exclusion_present_by_default(self):
        svc = _service_with_mock_client()
        svc._client.query.side_effect = _rows([self._trace_row()], [(1, 2, 0.5)])

        svc.get_session(project_id="p1", session_id="s1")

        sql, _ = _queries(svc)[0]
        assert EXCLUSION in sql
        assert "is_evaluation = 1" in _exclusion_subselect(sql)

    def test_include_evaluations_drops_the_predicate(self):
        svc = _service_with_mock_client()
        svc._client.query.side_effect = _rows([self._trace_row()], [(1, 2, 0.5)])

        svc.get_session(project_id="p1", session_id="s1", include_evaluations=True)

        sql, _ = _queries(svc)[0]
        assert EXCLUSION not in sql

    def test_evaluation_only_session_is_not_found(self):
        """End-to-end consequence: if every trace in the session is excluded the detail
        endpoint 404s rather than rendering an empty conversation."""
        svc = _service_with_mock_client()
        svc._client.query.side_effect = _rows([])

        assert svc.get_session(project_id="p1", session_id="s1") is None


# ── list_users ──────────────────────────────────────────────────────────


class TestListUsers:
    def test_exclusion_reaches_page_and_count(self):
        svc = _service_with_mock_client()
        svc._client.query.side_effect = _rows([], [[0]])

        svc.list_users(project_id="p1")

        page_sql, _ = _queries(svc)[0]
        count_sql, _ = _queries(svc)[1]
        assert EXCLUSION in page_sql
        assert EXCLUSION in count_sql
        assert "is_evaluation = 1" in _exclusion_subselect(page_sql)
        assert "is_evaluation = 1" in _exclusion_subselect(count_sql)

    def test_include_evaluations_drops_the_predicate(self):
        svc = _service_with_mock_client()
        svc._client.query.side_effect = _rows([], [[0]])

        svc.list_users(project_id="p1", include_evaluations=True)

        for sql, _ in _queries(svc):
            assert EXCLUSION not in sql


# ── every trace-derived read path is covered ────────────────────────────


def test_all_trace_scanning_read_paths_exclude_evaluations_by_default():
    """Catches the NEXT read path someone adds. Every public method that scans the
    ``traces`` table must take ``include_evaluations`` and default it to False; if a new
    aggregate view lands without it, this fails instead of silently double-counting.

    ``get_trace`` / ``get_trace_spans_io`` / ``get_span_io`` are deliberately absent: they
    are single-trace lookups by id, and an evaluation trace opened from a run's result
    link must still resolve. Hiding a trace from the LISTS is the feature; making it
    unopenable is not.
    """
    import inspect

    for method_name in ("list_traces", "list_sessions", "get_session", "list_users"):
        sig = inspect.signature(getattr(TraceReaderService, method_name))
        param = sig.parameters.get("include_evaluations")
        assert param is not None, f"{method_name} does not accept include_evaluations"
        assert param.default is False, f"{method_name} does not default to excluding"
