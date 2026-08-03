"""Wiring tests: a filter predicate must reach BOTH the page query and the count query.

The pagination-correctness invariant for the whole feature. ``list_traces`` runs two
physically separate queries — the paginated page and the ``count(DISTINCT ...)`` total
— off one shared ``where_clause``. If a filter reached only the page, ``meta.total``
would exceed the visible rows. These tests assert the filter condition is interpolated
into both, using a mocked ClickHouse client (no live DB), mirroring the repo's pattern.
"""

from datetime import datetime, timedelta
from unittest.mock import MagicMock

from rest.services.filters.translate import Predicate
from rest.services.token_rollup import authoritative_sum_expr
from rest.services.trace_reader import DEFAULT_SPAN_SCAN_LOOKBACK_HOURS, TraceReaderService

_MODEL_FILTER = [Predicate(field="model_name", op="in", value=["gpt-4"])]


def _service_with_mock_client():
    svc = TraceReaderService.__new__(TraceReaderService)  # skip real-client __init__
    svc._client = MagicMock()
    return svc


def _drive(svc):
    """Return (page_result, count_result) so list_traces yields an empty page, total 0."""
    page_res, count_res = MagicMock(), MagicMock()
    page_res.result_rows = []
    count_res.result_rows = [[0]]
    svc._client.query.side_effect = [page_res, count_res]


def test_membership_filter_lands_in_both_page_and_count_queries():
    svc = _service_with_mock_client()
    _drive(svc)

    svc.list_traces(
        project_id="p1",
        filters=[Predicate(field="model_name", op="in", value=["gpt-4"])],
    )

    assert svc._client.query.call_count == 2
    page_sql = svc._client.query.call_args_list[0].args[0]
    count_sql = svc._client.query.call_args_list[1].args[0]
    assert "t.trace_id IN (" in page_sql
    assert "t.trace_id IN (" in count_sql  # the invariant — filter reaches the count too
    params = svc._client.query.call_args_list[0].kwargs["parameters"]
    assert params["f_model_name_0"] == ["gpt-4"]


def test_independent_membership_predicates_emit_two_semijoins_in_both_queries():
    """Two membership predicates on different fields lower to TWO separate
    ``t.trace_id IN (...)`` semi-joins (independent existence, not one merged match), and
    both must reach the page AND the count query so page and total stay consistent."""
    svc = _service_with_mock_client()
    _drive(svc)

    svc.list_traces(
        project_id="p1",
        filters=[
            Predicate(field="model_name", op="in", value=["gpt-4"]),
            Predicate(field="environment", op="in", value=["prod"]),
        ],
    )

    page_sql = svc._client.query.call_args_list[0].args[0]
    count_sql = svc._client.query.call_args_list[1].args[0]
    for sql in (page_sql, count_sql):
        # Two independent semi-joins, each keyed on t.trace_id with its own field.
        assert sql.count("t.trace_id IN (") == 2
        assert "model_name IN" in sql
        assert "environment IN" in sql
    params = svc._client.query.call_args_list[0].kwargs["parameters"]
    assert params["f_model_name_0"] == ["gpt-4"]
    assert params["f_environment_1"] == ["prod"]


def test_aggregate_filter_lands_in_both_page_and_count_queries():
    svc = _service_with_mock_client()
    _drive(svc)

    svc.list_traces(
        project_id="p1",
        filters=[Predicate(field="cost", op="gt", value=0.5)],
    )

    page_sql = svc._client.query.call_args_list[0].args[0]
    count_sql = svc._client.query.call_args_list[1].args[0]
    assert "GROUP BY trace_id HAVING" in page_sql
    assert "GROUP BY trace_id HAVING" in count_sql


def test_trace_id_filter_lands_in_both_page_and_count_queries():
    """A trace-level trace_id filter is an inline t.trace_id predicate that must reach
    BOTH the page and count queries so the total stays consistent with the visible rows."""
    svc = _service_with_mock_client()
    _drive(svc)

    svc.list_traces(
        project_id="p1",
        filters=[Predicate(field="trace_id", op="contains", value="abc")],
    )

    page_sql = svc._client.query.call_args_list[0].args[0]
    count_sql = svc._client.query.call_args_list[1].args[0]
    assert "t.trace_id ILIKE" in page_sql
    assert "t.trace_id ILIKE" in count_sql
    assert svc._client.query.call_args_list[0].kwargs["parameters"]["f_trace_id_0"] == "%abc%"


def test_no_filters_adds_no_semijoin():
    svc = _service_with_mock_client()
    _drive(svc)

    svc.list_traces(project_id="p1")

    page_sql = svc._client.query.call_args_list[0].args[0]
    assert "t.trace_id IN (" not in page_sql


def test_list_traces_token_totals_prefer_api_counted_spans():
    svc = _service_with_mock_client()
    _drive(svc)

    svc.list_traces(project_id="p1")

    page_sql = svc._client.query.call_args_list[0].args[0]
    assert authoritative_sum_expr("input_tokens") in page_sql
    assert authoritative_sum_expr("output_tokens") in page_sql
    assert authoritative_sum_expr("cost") in page_sql
    assert "usage_details" in page_sql


def test_list_sessions_token_totals_prefer_api_counted_spans():
    svc = _service_with_mock_client()
    _drive(svc)

    svc.list_sessions(project_id="p1")

    page_sql = svc._client.query.call_args_list[0].args[0]
    assert authoritative_sum_expr("input_tokens") in page_sql
    assert authoritative_sum_expr("output_tokens") in page_sql
    assert authoritative_sum_expr("cost") in page_sql
    assert "usage_details" in page_sql


def test_get_session_sums_trace_level_authoritative_token_totals():
    svc = _service_with_mock_client()
    traces_res, tokens_res = MagicMock(), MagicMock()
    traces_res.result_rows = [
        (
            "trace-1",
            "trace",
            datetime(2026, 1, 1),
            "user-1",
            "input",
            "output",
            12,
            "ok",
        )
    ]
    tokens_res.result_rows = [(10, 20, 0.03)]
    svc._client.query.side_effect = [traces_res, tokens_res]

    svc.get_session(project_id="p1", session_id="s1")

    token_sql = svc._client.query.call_args_list[1].args[0]
    assert "GROUP BY trace_id" in token_sql
    assert "sum(total_input_tokens) as total_input_tokens" in token_sql
    assert "sum(total_output_tokens) as total_output_tokens" in token_sql
    assert "sum(total_cost) as total_cost" in token_sql
    assert authoritative_sum_expr("input_tokens") in token_sql
    assert authoritative_sum_expr("output_tokens") in token_sql
    assert authoritative_sum_expr("cost") in token_sql


def test_list_users_sums_trace_level_authoritative_token_totals():
    svc = _service_with_mock_client()
    _drive(svc)

    svc.list_users(project_id="p1")

    page_sql = svc._client.query.call_args_list[0].args[0]
    assert "span_trace_totals AS" in page_sql
    assert "GROUP BY trace_id" in page_sql
    assert "sum(stt.total_input_tokens) as total_input_tokens" in page_sql
    assert "sum(stt.total_output_tokens) as total_output_tokens" in page_sql
    assert "sum(stt.total_cost) as total_cost" in page_sql
    assert authoritative_sum_expr("input_tokens") in page_sql
    assert authoritative_sum_expr("output_tokens") in page_sql
    assert authoritative_sum_expr("cost") in page_sql


def test_filtered_list_without_window_gets_default_lookback_in_both_queries():
    """A filtered list with no lower time bound must not emit an unbounded span scan:
    a default lookback is injected into the page and count queries and bounds the spans."""
    svc = _service_with_mock_client()
    _drive(svc)

    svc.list_traces(project_id="p1", filters=_MODEL_FILTER)

    page_sql = svc._client.query.call_args_list[0].args[0]
    count_sql = svc._client.query.call_args_list[1].args[0]
    assert "t.trace_start_time >= {start_after:DateTime64(3)}" in page_sql
    assert "t.trace_start_time >= {start_after:DateTime64(3)}" in count_sql
    # The span semi-join is time-bounded (partition pruning), not all-time.
    assert "span_start_time >= {start_after:DateTime64(3)}" in page_sql
    assert "start_after" in svc._client.query.call_args_list[0].kwargs["parameters"]


def test_explicit_start_after_is_not_overridden_by_the_default():
    svc = _service_with_mock_client()
    _drive(svc)
    explicit = datetime(2026, 6, 1)

    svc.list_traces(project_id="p1", start_after=explicit, filters=_MODEL_FILTER)

    params = svc._client.query.call_args_list[0].kwargs["parameters"]
    assert params["start_after"] == explicit  # the caller's window wins


def test_default_lookback_is_relative_to_end_before_when_present():
    svc = _service_with_mock_client()
    _drive(svc)
    end = datetime(2026, 6, 2, 12, 0, 0)

    svc.list_traces(project_id="p1", end_before=end, filters=_MODEL_FILTER)

    params = svc._client.query.call_args_list[0].kwargs["parameters"]
    assert params["start_after"] == end - timedelta(hours=DEFAULT_SPAN_SCAN_LOOKBACK_HOURS)


def test_unfiltered_list_without_window_stays_unbounded():
    """The default lookback is a filtered-path guard; unfiltered behavior is unchanged."""
    svc = _service_with_mock_client()
    _drive(svc)

    svc.list_traces(project_id="p1")

    page_sql = svc._client.query.call_args_list[0].args[0]
    params = svc._client.query.call_args_list[0].kwargs["parameters"]
    assert "start_after" not in params
    assert "t.trace_start_time >=" not in page_sql
