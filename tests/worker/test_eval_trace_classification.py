"""Offline-evaluation traces must be classified on ingest by a dedicated signal.

Acceptance criteria under test: an evaluation trace is never indistinguishable from an
ordinary trace — its root always carries the classification — AND the user's
`traceroot.environment` deployment tag survives untouched, because the two are
orthogonal concepts that must not share a field.
"""

from unittest.mock import MagicMock

from db.clickhouse.client import ClickHouseClient
from tests.fixtures.otel_payloads import make_attr, make_otel_payload, make_span
from worker.otel_transform import transform_otel_to_clickhouse

PROJECT = "proj-eval"
TRACE_ID = "1a" * 16
ROOT_SPAN_ID = "01" * 8
TASK_SPAN_ID = "02" * 8
SCORER_SPAN_ID = "03" * 8


def _eval_span(span_id, kind, *, parent=None, environment=None, name="eval-span"):
    attributes = [make_attr("traceroot.span.type", kind)]
    if environment is not None:
        attributes.append(make_attr("traceroot.environment", environment))
    return make_span(
        TRACE_ID,
        span_id,
        name=name,
        parent_span_id_hex=parent,
        attributes=attributes,
    )


def _transform(spans):
    return transform_otel_to_clickhouse(make_otel_payload(spans), PROJECT)


def _insert_rows(*, spans=None, traces=None):
    """Run the real insert against a mocked driver; return (rows, column_names)."""
    mock_internal = MagicMock()
    client = ClickHouseClient(mock_internal)
    if spans is not None:
        client.insert_spans_batch(spans)
    if traces is not None:
        client.insert_traces_batch(traces)
    call_args = mock_internal.insert.call_args
    return call_args[0][1], call_args[1]["column_names"]


class TestSpanKindsArePreserved:
    def test_evaluation_task_scorer_kinds_survive_the_transform(self):
        traces, spans = _transform(
            [
                _eval_span(ROOT_SPAN_ID, "EVALUATION"),
                _eval_span(TASK_SPAN_ID, "TASK", parent=ROOT_SPAN_ID),
                _eval_span(SCORER_SPAN_ID, "SCORER", parent=ROOT_SPAN_ID),
            ]
        )
        assert {s["span_kind"] for s in spans} == {"EVALUATION", "TASK", "SCORER"}
        assert len(traces) == 1


class TestClassificationIsIndependentOfEnvironment:
    """The critical regression: gating classification on `environment is None` makes it
    silently never fire whenever TRACEROOT_ENVIRONMENT is set — the common case in CI
    or any SDK-initialised app, since those spans already carry the attribute."""

    def test_classified_when_the_sdk_stamped_an_environment(self):
        # Mutation caught: re-adding an `environment is None` guard around the
        # classification, or deriving it from anything other than the span kind.
        traces, spans = _transform(
            [
                _eval_span(ROOT_SPAN_ID, "EVALUATION", environment="staging"),
                _eval_span(TASK_SPAN_ID, "TASK", parent=ROOT_SPAN_ID, environment="staging"),
            ]
        )
        assert traces[0]["is_evaluation"] is True
        assert all(s["is_evaluation"] is True for s in spans)

    def test_user_environment_value_is_preserved_not_overwritten(self):
        # Mutation caught: setting `environment = "evaluation"` on eval spans. The
        # deployment tag is user-namespace data and must round-trip unchanged.
        traces, spans = _transform(
            [
                _eval_span(ROOT_SPAN_ID, "EVALUATION", environment="staging"),
                _eval_span(TASK_SPAN_ID, "TASK", parent=ROOT_SPAN_ID, environment="staging"),
            ]
        )
        assert traces[0]["environment"] == "staging"
        assert {s["environment"] for s in spans} == {"staging"}

    def test_user_named_environment_evaluation_is_not_classified(self):
        # The inverse hazard of overloading the field: a customer who legitimately
        # names their environment "evaluation" must NOT have ordinary traces hidden.
        traces, spans = _transform(
            [
                make_span(
                    TRACE_ID,
                    ROOT_SPAN_ID,
                    attributes=[make_attr("traceroot.environment", "evaluation")],
                )
            ]
        )
        assert traces[0]["environment"] == "evaluation"
        assert traces[0].get("is_evaluation") is not True
        assert spans[0].get("is_evaluation") is not True

    def test_ordinary_trace_is_not_classified(self):
        traces, spans = _transform([make_span(TRACE_ID, ROOT_SPAN_ID)])
        assert traces[0].get("is_evaluation") is not True
        assert spans[0].get("is_evaluation") is not True


class TestRootArrivesInALaterBatch:
    """OTel's BatchSpanProcessor exports a span when it ENDS, so the EVALUATION root is
    normally the LAST span of the trace to arrive. A batch of children alone must still
    write a classified trace row, or a crashed eval run stays misclassified forever."""

    def test_children_only_batch_classifies_the_shallow_trace_record(self):
        # Mutation caught: reading is_evaluation only inside the `if not parent_span_id`
        # root-upgrade block, leaving the eager shallow record unclassified.
        traces, spans = _transform(
            [
                _eval_span(SCORER_SPAN_ID, "SCORER", parent=TASK_SPAN_ID),
                _eval_span(TASK_SPAN_ID, "TASK", parent=ROOT_SPAN_ID),
            ]
        )
        assert traces[0]["is_evaluation"] is True
        assert all(s["is_evaluation"] is True for s in spans)

    def test_trace_record_is_never_less_classified_than_its_spans(self):
        """A batch where only some spans are eval-kind (the TASK's own LLM child has
        kind LLM) still classifies the trace."""
        traces, spans = _transform(
            [
                make_span(
                    TRACE_ID,
                    "04" * 8,
                    parent_span_id_hex=TASK_SPAN_ID,
                    attributes=[make_attr("traceroot.span.type", "LLM")],
                ),
                _eval_span(TASK_SPAN_ID, "TASK", parent=ROOT_SPAN_ID),
            ]
        )
        assert traces[0]["is_evaluation"] is True
        assert any(s.get("is_evaluation") is True for s in spans)

    def test_children_only_batch_carries_the_environment_tag(self):
        # Mutation caught: dropping `environment` from the eager shallow trace record,
        # which leaves a late-root trace with a NULL environment facet.
        traces, _ = _transform(
            [
                _eval_span(TASK_SPAN_ID, "TASK", parent=ROOT_SPAN_ID, environment="staging"),
            ]
        )
        assert traces[0]["environment"] == "staging"

    def test_root_environment_wins_over_a_child_in_the_same_batch(self):
        traces, _ = _transform(
            [
                _eval_span(TASK_SPAN_ID, "TASK", parent=ROOT_SPAN_ID, environment="child-env"),
                _eval_span(ROOT_SPAN_ID, "EVALUATION", environment="root-env"),
            ]
        )
        assert traces[0]["environment"] == "root-env"


class TestClassificationReachesTheInsertRow:
    """The signal is only useful if it is persisted — the traces list and the detector
    scheduler read it back to exclude evaluation traces by default."""

    def test_trace_insert_carries_is_evaluation_and_environment_separately(self):
        traces, _ = _transform([_eval_span(ROOT_SPAN_ID, "EVALUATION", environment="staging")])
        rows, columns = _insert_rows(traces=traces)
        # Mutation caught: the duplicated `environment` entry in the column list, which
        # made every ingest insert send two columns of the same name.
        assert columns.count("environment") == 1
        assert columns.count("is_evaluation") == 1
        assert len(rows[0]) == len(columns)
        assert rows[0][columns.index("environment")] == "staging"
        assert rows[0][columns.index("is_evaluation")] == 1

    def test_span_insert_carries_is_evaluation_and_environment_separately(self):
        _, spans = _transform([_eval_span(ROOT_SPAN_ID, "EVALUATION", environment="staging")])
        rows, columns = _insert_rows(spans=spans)
        assert columns.count("environment") == 1
        assert columns.count("is_evaluation") == 1
        assert len(rows[0]) == len(columns)
        assert rows[0][columns.index("environment")] == "staging"
        assert rows[0][columns.index("is_evaluation")] == 1

    def test_ordinary_trace_inserts_a_zero_flag(self):
        traces, spans = _transform([make_span(TRACE_ID, ROOT_SPAN_ID)])
        rows, columns = _insert_rows(traces=traces)
        assert rows[0][columns.index("is_evaluation")] == 0
        rows, columns = _insert_rows(spans=spans)
        assert rows[0][columns.index("is_evaluation")] == 0


class TestInsertColumnListsAreWellFormed:
    """A duplicate name in a ClickHouse INSERT column list is rejected by the server and
    takes out ALL trace and span ingest — while every client-side assertion still passes,
    because the row length still matches. Guard the shape directly rather than relying on
    a test that happens to look at one column."""

    def test_trace_insert_column_names_have_no_duplicates(self):
        traces, _ = _transform([make_span(TRACE_ID, ROOT_SPAN_ID)])
        rows, columns = _insert_rows(traces=traces)
        assert len(columns) == len(set(columns)), f"duplicate trace insert columns: {columns}"
        assert len(rows[0]) == len(columns)

    def test_span_insert_column_names_have_no_duplicates(self):
        _, spans = _transform([make_span(TRACE_ID, ROOT_SPAN_ID)])
        rows, columns = _insert_rows(spans=spans)
        assert len(columns) == len(set(columns)), f"duplicate span insert columns: {columns}"
        assert len(rows[0]) == len(columns)
