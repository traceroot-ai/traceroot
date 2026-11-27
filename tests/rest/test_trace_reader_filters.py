"""Wiring tests: a filter predicate must reach BOTH the page query and the count query.

The pagination-correctness invariant for the whole feature. ``list_traces`` runs two
physically separate queries — the paginated page and the ``count(DISTINCT ...)`` total
— off one shared ``where_clause``. If a filter reached only the page, ``meta.total``
would exceed the visible rows. These tests assert the filter condition is interpolated
into both, using a mocked ClickHouse client (no live DB), mirroring the repo's pattern.

The same page/count split is why the execution bounds are asserted here too: settings
are per-query, so bounding the page leaves the count free to run until the client gives
up.
"""

from datetime import datetime, timedelta
from unittest.mock import MagicMock

from db.clickhouse.query_settings import QUERY_TIMEOUT_S, READ_QUERY_SETTINGS
from rest.services.filters.translate import Predicate
from rest.services.trace_reader import DEFAULT_SPAN_SCAN_LOOKBACK_HOURS, TraceReaderService

_MODEL_FILTER = [Predicate(field="model_name", op="in", value=["gpt-4"])]
_METADATA_FILTER = [Predicate(field="metadata", op="eq", value="acme-corp", key="tenant_id")]


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


def test_metadata_filter_lands_in_both_page_and_count_queries():
    """A keyed predicate joins the SAME shared condition list as every other filter, so
    the metadata-filtered page and its total can never disagree."""
    svc = _service_with_mock_client()
    _drive(svc)

    svc.list_traces(project_id="p1", filters=_METADATA_FILTER)

    assert svc._client.query.call_count == 2
    page_sql = svc._client.query.call_args_list[0].args[0]
    count_sql = svc._client.query.call_args_list[1].args[0]
    for sql in (page_sql, count_sql):
        assert "mapContains(metadata_map, {f_metadata_0_key:String})" in sql
        assert "metadata_map[{f_metadata_0_key:String}] = {f_metadata_0:String}" in sql
    # One parameter map feeds both queries, so the bound key/value are shared too.
    params = svc._client.query.call_args_list[0].kwargs["parameters"]
    assert params["f_metadata_0_key"] == "tenant_id"
    assert params["f_metadata_0"] == "acme-corp"
    assert svc._client.query.call_args_list[1].kwargs["parameters"] is params


def _trace_where_clauses(sql: str) -> tuple[str, str]:
    """The (dedup scope, predicate) WHERE clauses of an assembled list query.

    The scope bounds the rows deduped to each trace's latest version; the predicate line
    is where every condition the translator produced is AND-joined together — the place
    where a loosely-bound operator in one condition would reach the others.
    """
    scope, predicates = (
        line.strip() for line in sql.splitlines() if line.strip().startswith("WHERE t.")
    )
    return scope, predicates


def _or_operators_outside_parentheses(clause: str) -> int:
    """Count ``OR`` operators in ``clause`` that sit outside every parenthesis group.

    The conditions are AND-joined and OR binds looser than AND, so an OR left outside the
    parentheses is an OR that takes the conditions beside it as its arms.
    """
    count = 0
    depth = 0
    for i, ch in enumerate(clause):
        if ch == "(":
            depth += 1
        elif ch == ")":
            depth -= 1
        elif depth == 0 and clause.startswith(" OR ", i):
            count += 1
    return count


def test_metadata_filter_matches_either_scope_in_both_queries():
    """Both halves of the predicate reach the page and the count. A trace-level tag can
    never appear on a span, so a span-only match would drop exactly the traces whose cell
    the user clicked."""
    svc = _service_with_mock_client()
    _drive(svc)

    svc.list_traces(project_id="p1", filters=_METADATA_FILTER)

    page_sql = svc._client.query.call_args_list[0].args[0]
    count_sql = svc._client.query.call_args_list[1].args[0]
    for sql in (page_sql, count_sql):
        assert "mapContains(t.metadata_map, {f_metadata_0_key:String})" in sql  # trace row
        assert "mapContains(metadata_map, {f_metadata_0_key:String})" in sql  # its spans


def test_a_metadata_filter_does_not_widen_the_filters_beside_it():
    """The assembled WHERE clause stays a conjunction: the window and the model_name
    filter still constrain the result even though the metadata condition contains an OR.
    Left unparenthesised, a row matching only the metadata span half would satisfy the
    whole clause and the date range would stop applying."""
    svc = _service_with_mock_client()
    _drive(svc)

    svc.list_traces(
        project_id="p1",
        start_after=datetime(2026, 6, 1),
        end_before=datetime(2026, 6, 2),
        filters=_MODEL_FILTER + _METADATA_FILTER,
    )

    for call in svc._client.query.call_args_list:
        scope, clause = _trace_where_clauses(call.args[0])
        assert " OR " in clause  # the metadata predicate is present
        assert _or_operators_outside_parentheses(clause) == 0
        # ... and the conditions it sits beside still apply.
        assert "t.trace_start_time >= {start_after:DateTime64(3)} AND" in scope
        assert "t.trace_start_time < {end_before:DateTime64(3)}" in scope
        assert "model_name IN {f_model_name_0:Array(String)}" in clause


def test_metadata_filter_inherits_the_list_window_in_both_queries():
    """The picked date range is the outer bound: the trace query is bounded at both ends
    and the metadata span scan inherits the same lower bound (backed off for drift)."""
    svc = _service_with_mock_client()
    _drive(svc)
    start, end = datetime(2026, 6, 1), datetime(2026, 6, 2)

    svc.list_traces(project_id="p1", start_after=start, end_before=end, filters=_METADATA_FILTER)

    page_sql = svc._client.query.call_args_list[0].args[0]
    count_sql = svc._client.query.call_args_list[1].args[0]
    for sql in (page_sql, count_sql):
        assert "t.trace_start_time >= {start_after:DateTime64(3)}" in sql
        assert "t.trace_start_time < {end_before:DateTime64(3)}" in sql
        assert "span_start_time >= {start_after:DateTime64(3)} - INTERVAL" in sql
    params = svc._client.query.call_args_list[0].kwargs["parameters"]
    assert params["start_after"] == start
    assert params["end_before"] == end


def test_metadata_filter_without_a_window_gets_the_default_lookback():
    """A metadata-filtered list with no lower bound must not emit an all-time span scan;
    it is defaulted exactly like the categorical membership path."""
    svc = _service_with_mock_client()
    _drive(svc)

    svc.list_traces(project_id="p1", filters=_METADATA_FILTER)

    page_sql = svc._client.query.call_args_list[0].args[0]
    assert "t.trace_start_time >= {start_after:DateTime64(3)}" in page_sql
    assert "span_start_time >= {start_after:DateTime64(3)} - INTERVAL" in page_sql
    assert "start_after" in svc._client.query.call_args_list[0].kwargs["parameters"]


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


# ── Execution bounds: both queries, not just the page ────────────────────────────
#
# Same shape as the filter-wiring invariant above and the same failure mode: the count
# query is physically separate from the page query, so a bound applied to one is not
# applied to the other. The count is the easier of the two to forget precisely because
# nothing in the response reveals it ran — and it scans the same filtered predicate.


def test_page_query_runs_under_the_shared_read_bounds():
    svc = _service_with_mock_client()
    _drive(svc)

    svc.list_traces(project_id="p1")

    page_settings = svc._client.query.call_args_list[0].kwargs.get("settings")
    assert page_settings is READ_QUERY_SETTINGS


def test_count_query_runs_under_the_shared_read_bounds():
    """The count is a second unbounded scan if it is left out — it re-evaluates the same
    ``where_clause`` the page did, keyed-metadata semi-joins and all."""
    svc = _service_with_mock_client()
    _drive(svc)

    svc.list_traces(project_id="p1")

    assert svc._client.query.call_count == 2
    count_settings = svc._client.query.call_args_list[1].kwargs.get("settings")
    assert count_settings is READ_QUERY_SETTINGS


def test_trace_ids_condition_lands_in_both_page_and_count_queries():
    """A ``trace_ids`` lookup joins the SAME shared condition list as every other
    filter, so the page and its total can never disagree."""
    svc = _service_with_mock_client()
    _drive(svc)

    svc.list_traces(project_id="p1", trace_ids=["t-a", "t-b"])

    assert svc._client.query.call_count == 2
    page_sql = svc._client.query.call_args_list[0].args[0]
    count_sql = svc._client.query.call_args_list[1].args[0]
    assert "t.trace_id IN {trace_ids:Array(String)}" in page_sql
    assert "t.trace_id IN {trace_ids:Array(String)}" in count_sql
    page_params = svc._client.query.call_args_list[0].kwargs["parameters"]
    count_params = svc._client.query.call_args_list[1].kwargs["parameters"]
    assert page_params["trace_ids"] == ["t-a", "t-b"]
    assert count_params["trace_ids"] == ["t-a", "t-b"]


def test_no_trace_ids_adds_no_condition():
    svc = _service_with_mock_client()
    _drive(svc)

    svc.list_traces(project_id="p1")

    page_sql = svc._client.query.call_args_list[0].args[0]
    params = svc._client.query.call_args_list[0].kwargs["parameters"]
    assert "t.trace_id IN {trace_ids:Array(String)}" not in page_sql
    assert "trace_ids" not in params


def test_empty_trace_ids_list_is_treated_like_absent():
    svc = _service_with_mock_client()
    _drive(svc)

    svc.list_traces(project_id="p1", trace_ids=[])

    page_sql = svc._client.query.call_args_list[0].args[0]
    assert "t.trace_id IN {trace_ids:Array(String)}" not in page_sql


def test_trace_ids_without_a_window_stays_unbounded():
    """trace_ids is a lookup by known id, not a scan: unlike the ``filters`` path it
    must NOT get the default lookback window — a signal's traces can be weeks old."""
    svc = _service_with_mock_client()
    _drive(svc)

    svc.list_traces(project_id="p1", trace_ids=["t-a"])

    page_sql = svc._client.query.call_args_list[0].args[0]
    params = svc._client.query.call_args_list[0].kwargs["parameters"]
    assert "t.trace_start_time >=" not in page_sql
    assert "start_after" not in params


def test_trace_ids_with_filters_keeps_the_default_lookback():
    """Filters scan spans, and that scan is bounded only by start_after: a trace_ids
    lookup that also carries filters keeps the default lookback, in the span scan and
    in both the page and the count query."""
    svc = _service_with_mock_client()
    _drive(svc)

    svc.list_traces(project_id="p1", trace_ids=["t-a"], filters=_MODEL_FILTER)

    page_sql = svc._client.query.call_args_list[0].args[0]
    count_sql = svc._client.query.call_args_list[1].args[0]
    params = svc._client.query.call_args_list[0].kwargs["parameters"]
    assert "t.trace_start_time >= {start_after:DateTime64(3)}" in page_sql
    assert "t.trace_start_time >= {start_after:DateTime64(3)}" in count_sql
    assert "span_start_time >=" in page_sql
    assert "start_after" in params


def test_trace_ids_still_honors_an_explicit_window():
    """An explicit start_after/end_before still narrows a trace_ids lookup; only the
    IMPLICIT default lookback is skipped."""
    svc = _service_with_mock_client()
    _drive(svc)
    start, end = datetime(2026, 1, 1), datetime(2026, 1, 2)

    svc.list_traces(project_id="p1", trace_ids=["t-a"], start_after=start, end_before=end)

    page_sql = svc._client.query.call_args_list[0].args[0]
    params = svc._client.query.call_args_list[0].kwargs["parameters"]
    assert "t.trace_start_time >= {start_after:DateTime64(3)}" in page_sql
    assert "t.trace_start_time < {end_before:DateTime64(3)}" in page_sql
    assert params["start_after"] == start
    assert params["end_before"] == end


def test_trace_ids_still_scopes_to_the_project():
    svc = _service_with_mock_client()
    _drive(svc)

    svc.list_traces(project_id="p1", trace_ids=["t-a"])

    page_sql = svc._client.query.call_args_list[0].args[0]
    assert "t.project_id = {project_id:String}" in page_sql


def test_both_queries_carry_an_execution_ceiling_and_the_readonly_flag():
    """The properties the bounds exist for, asserted on what the queries actually got.

    Identity with the shared mapping is the primary guard (above); this pins the two
    properties that make it a bound at all, so emptying or renaming a field in the shared
    module fails here rather than silently unbinding the widest scan the dashboard runs.
    A filtered list is used because that is the path that reaches the base table.
    """
    svc = _service_with_mock_client()
    _drive(svc)

    svc.list_traces(project_id="p1", filters=_METADATA_FILTER)

    for call in svc._client.query.call_args_list:
        settings = call.kwargs["settings"]
        assert settings["max_execution_time"] == QUERY_TIMEOUT_S
        assert settings["readonly"] == 1


# ── Version-dependent predicates run after the ReplacingMergeTree dedup ───────────
#
# A trace is written more than once: an eager row from the first child span to export,
# then the root's row with the real name, start time and user. Until ClickHouse merges
# the parts, both rows are live. A predicate applied before ``LIMIT 1 BY`` matches the
# superseded row, so a filter for the eager span's name returns the trace under that
# stale name. The predicates must judge only the latest version.

_DEDUP = "LIMIT 1 BY t.project_id, t.trace_id"
_PAGE_LIMIT = "LIMIT {limit:UInt32}"


def _judged_after_dedup(sql: str, *predicates: str, until: str | None = None) -> bool:
    """Each predicate filters the deduped rows: after the first dedup, and before ``until``.

    ``until`` marks the end of the stage that decides membership (the page's LIMIT), so a
    predicate that moved to a later stage, such as the per-page row read, fails too.
    """
    start = sql.index(_DEDUP) + len(_DEDUP)
    end = sql.index(until, start) if until else len(sql)
    return all(p in sql[start:end] for p in predicates)


def test_trace_attribute_predicates_judge_the_latest_trace_version():
    svc = _service_with_mock_client()
    _drive(svc)

    svc.list_traces(
        project_id="p1",
        name="openai",
        user_id="u1",
        search_query="openai",
        filters=_MODEL_FILTER,
    )

    page_sql = svc._client.query.call_args_list[0].args[0]
    count_sql = svc._client.query.call_args_list[1].args[0]
    predicates = (
        "t.name ILIKE {name:String}",
        "t.user_id = {user_id:String}",
        "{search_kw:String}",
    )
    assert _judged_after_dedup(page_sql, *predicates, until=_PAGE_LIMIT)
    assert _judged_after_dedup(count_sql, *predicates)


def test_label_candidates_judge_the_latest_trace_version():
    svc = _service_with_mock_client()
    svc._client.query.return_value.result_rows = []

    svc.matching_trace_ids(
        ["t1"],
        project_id="p1",
        name="openai",
        user_id=None,
        start_after=None,
        end_before=None,
        search_query=None,
        filters=[],
        include_evaluations=True,
    )

    sql = svc._client.query.call_args.args[0]
    assert _judged_after_dedup(sql, "t.name ILIKE {name:String}")


def test_session_search_judges_the_latest_trace_version():
    svc = _service_with_mock_client()
    page_res, count_res = MagicMock(), MagicMock()
    page_res.result_rows = []
    count_res.result_rows = [[0]]
    svc._client.query.side_effect = [page_res, count_res]

    svc.list_sessions(project_id="p1", search_query="sess")

    page_sql = svc._client.query.call_args_list[0].args[0]
    count_sql = svc._client.query.call_args_list[1].args[0]
    session_page, traces_dedup = page_sql.split("traces_dedup AS", 1)
    search = "t.session_id ILIKE {search_kw:String}"
    assert _judged_after_dedup(session_page, search, until=_PAGE_LIMIT)
    assert _judged_after_dedup(traces_dedup, search)
    assert _judged_after_dedup(count_sql, search)
