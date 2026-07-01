"""Wiring tests: a filter predicate must reach BOTH the page query and the count query.

The pagination-correctness invariant for the whole feature. ``list_traces`` runs two
physically separate queries — the paginated page and the ``count(DISTINCT ...)`` total
— off one shared ``where_clause``. If a filter reached only the page, ``meta.total``
would exceed the visible rows. These tests assert the filter condition is interpolated
into both, using a mocked ClickHouse client (no live DB), mirroring the repo's pattern.
"""

from unittest.mock import MagicMock

from rest.services.filters.translate import Predicate
from rest.services.trace_reader import TraceReaderService


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


def test_aggregate_filter_lands_in_both_page_and_count_queries():
    svc = _service_with_mock_client()
    _drive(svc)

    svc.list_traces(
        project_id="p1",
        filters=[Predicate(field="cost", op="between", value=[0.5, None])],
    )

    page_sql = svc._client.query.call_args_list[0].args[0]
    count_sql = svc._client.query.call_args_list[1].args[0]
    assert "GROUP BY trace_id HAVING" in page_sql
    assert "GROUP BY trace_id HAVING" in count_sql


def test_no_filters_adds_no_semijoin():
    svc = _service_with_mock_client()
    _drive(svc)

    svc.list_traces(project_id="p1")

    page_sql = svc._client.query.call_args_list[0].args[0]
    assert "t.trace_id IN (" not in page_sql
