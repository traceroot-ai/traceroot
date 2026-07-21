"""Integration-style test: the `traceroot.environment` OTEL attribute must
survive the full transform -> ClickHouse insert -> trigger evaluation path.

Mirrors the acceptance criteria for the environment ingest fix: a stored
environment value must reach the trigger evaluator non-NULL and drive
`=` / `!=` conditions correctly, rather than being silently dropped at the
insert layer and inverting every condition via the missing-field fallback.
"""

from unittest.mock import MagicMock

from db.clickhouse.client import ClickHouseClient
from tests.fixtures.otel_payloads import make_attr, make_otel_payload, make_span
from worker.detector_tasks import _eval_condition
from worker.otel_transform import transform_otel_to_clickhouse


def _captured_insert(spans=None, traces=None):
    """Run the real insert functions against a mocked internal client and
    return (rows, column_names) for the single insert call made."""
    mock_internal = MagicMock()
    client = ClickHouseClient(mock_internal)
    if spans is not None:
        client.insert_spans_batch(spans)
    if traces is not None:
        client.insert_traces_batch(traces)

    call_args = mock_internal.insert.call_args
    rows = call_args[0][1]
    columns = call_args[1]["column_names"]
    return rows, columns


class TestEnvironmentRoundTrip:
    def test_span_environment_attribute_reaches_insert_row(self):
        trace_id = "aa" * 16
        span_id = "bb" * 8
        payload = make_otel_payload(
            [
                make_span(
                    trace_id,
                    span_id,
                    attributes=[make_attr("traceroot.environment", "production")],
                )
            ]
        )

        _, spans = transform_otel_to_clickhouse(payload, "proj-envfix")
        assert spans[0]["environment"] == "production"

        rows, columns = _captured_insert(spans=spans)
        env_index = columns.index("environment")
        assert rows[0][env_index] == "production"

    def test_trace_environment_attribute_reaches_insert_row(self):
        trace_id = "cc" * 16
        span_id = "dd" * 8
        payload = make_otel_payload(
            [
                make_span(
                    trace_id,
                    span_id,
                    attributes=[make_attr("traceroot.environment", "production")],
                )
            ]
        )

        traces, _ = transform_otel_to_clickhouse(payload, "proj-envfix")
        assert traces[0]["environment"] == "production"

        rows, columns = _captured_insert(traces=traces)
        env_index = columns.index("environment")
        assert rows[0][env_index] == "production"

    def test_stored_environment_drives_trigger_evaluation(self):
        """Once environment round-trips through insert (rather than landing as
        NULL), `_get_trace_summaries` would surface it non-NULL; this asserts
        that value then makes `=` and `!=` conditions behave correctly instead
        of falling through the missing-field branch."""
        trace_id = "ee" * 16
        span_id = "ff" * 8
        payload = make_otel_payload(
            [
                make_span(
                    trace_id,
                    span_id,
                    attributes=[make_attr("traceroot.environment", "production")],
                )
            ]
        )

        _, spans = transform_otel_to_clickhouse(payload, "proj-envfix")
        rows, columns = _captured_insert(spans=spans)
        env_index = columns.index("environment")
        stored_environment = rows[0][env_index]

        # What _get_trace_summaries would hand to trigger evaluation once the
        # value is actually persisted instead of NULL.
        trace_summary = {"environment": stored_environment}

        assert (
            _eval_condition(
                trace_summary, {"field": "environment", "op": "=", "value": "production"}
            )
            is True
        )
        assert (
            _eval_condition(trace_summary, {"field": "environment", "op": "=", "value": "staging"})
            is False
        )
        assert (
            _eval_condition(trace_summary, {"field": "environment", "op": "!=", "value": "staging"})
            is True
        )
        assert (
            _eval_condition(
                trace_summary, {"field": "environment", "op": "!=", "value": "production"}
            )
            is False
        )


class TestMistypedEnvironmentDoesNotReachInsert:
    """A mis-typed `traceroot.environment` attribute (e.g. int/list from a
    misbehaving SDK) must degrade to NULL at the transform layer rather than
    reaching the Nullable(String) insert, where a non-string value would
    raise during column serialization and fail the entire batch."""

    def test_int_environment_carries_none_through_span_insert(self):
        payload = make_otel_payload(
            [
                make_span(
                    "aa" * 16,
                    "bb" * 8,
                    attributes=[make_attr("traceroot.environment", 5)],
                )
            ]
        )
        _, spans = transform_otel_to_clickhouse(payload, "proj-envfix")

        rows, columns = _captured_insert(spans=spans)
        env_index = columns.index("environment")
        assert rows[0][env_index] is None

    def test_int_environment_carries_none_through_trace_insert(self):
        payload = make_otel_payload(
            [
                make_span(
                    "aa" * 16,
                    "bb" * 8,
                    attributes=[make_attr("traceroot.environment", 5)],
                )
            ]
        )
        traces, _ = transform_otel_to_clickhouse(payload, "proj-envfix")

        rows, columns = _captured_insert(traces=traces)
        env_index = columns.index("environment")
        assert rows[0][env_index] is None
