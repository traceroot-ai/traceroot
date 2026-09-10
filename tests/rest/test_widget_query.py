"""Tests for the widget spec models and the spec-to-SQL compiler."""

from datetime import UTC, datetime
from typing import get_args
from unittest.mock import MagicMock

import pytest
from fastapi.encoders import jsonable_encoder
from pydantic import ValidationError

from db.clickhouse.query_settings import (
    GROUP_BY_SPILL_BYTES,
    QUERY_TIMEOUT_S,
    READ_QUERY_SETTINGS,
)
from rest.schemas.dashboards import (
    AggName,
    WidgetFilter,
    WidgetQueryRequest,
    WidgetQueryResponse,
    WidgetSpec,
)
from rest.services import widget_query as wq
from rest.services.widget_query import WidgetSpecError, compile_widget_query
from rest.services.widget_registry import (
    AGGS_NUMBER,
    FILTER_OPS_NUMBER,
    FILTER_OPS_STRING,
    REGISTRY,
)


def make_spec(**overrides) -> dict:
    spec = {
        "view": "spans",
        "filters": [{"field": "span_kind", "op": "=", "value": "LLM"}],
        "metric": {"measure": "cost", "agg": "sum"},
        "breakdown": "model_name",
        "display": {"type": "line"},
    }
    spec.update(overrides)
    return spec


def test_valid_spec_parses():
    spec = WidgetSpec.model_validate(make_spec())
    assert spec.view == "spans"
    assert spec.metric.agg == "sum"


def test_unknown_view_rejected():
    with pytest.raises(ValidationError):
        WidgetSpec.model_validate(make_spec(view="secrets"))


def test_unknown_display_rejected():
    with pytest.raises(ValidationError):
        WidgetSpec.model_validate(make_spec(display={"type": "gauge"}))


def test_request_requires_start_and_end_time():
    with pytest.raises(ValidationError):
        WidgetQueryRequest.model_validate({"spec": make_spec()})


# --- Drift-guard tests ---


def test_agg_name_matches_registry():
    """AggName Literal must stay in sync with AGGS_NUMBER plus 'count'."""
    assert set(get_args(AggName)) == set(AGGS_NUMBER) | {"count"}


def test_view_literal_matches_registry():
    """WidgetSpec.view Literal must list exactly the views in REGISTRY."""
    view_annotation = WidgetSpec.model_fields["view"].annotation
    assert set(get_args(view_annotation)) == set(REGISTRY)


def test_filter_op_matches_registry():
    """WidgetFilter.op Literal must cover all string and number filter ops."""
    op_annotation = WidgetFilter.model_fields["op"].annotation
    assert set(get_args(op_annotation)) == set(FILTER_OPS_STRING) | set(FILTER_OPS_NUMBER)


# --- extra="forbid" tests ---


def test_unknown_key_in_spec_rejected():
    """A payload with 'filter' (singular, misspelled) must raise ValidationError."""
    bad_payload = make_spec()
    bad_payload["filter"] = bad_payload.pop("filters")  # misspell the key
    with pytest.raises(ValidationError):
        WidgetSpec.model_validate(bad_payload)


# --- SQL compiler tests ---

START = datetime(2026, 6, 1)
END = datetime(2026, 6, 8)


def compile_(spec_dict):
    spec = WidgetSpec.model_validate(spec_dict)
    return compile_widget_query(spec, project_id="proj-1", start_time=START, end_time=END)


def test_compile_breakdown_bar():
    sql, params = compile_(make_spec(display={"type": "bar"}))
    assert "GROUP BY model_name" in sql
    assert "sum(cost)" in sql
    assert "span_kind = {f0:String}" in sql
    assert params["f0"] == "LLM"
    assert params["project_id"] == "proj-1"
    # top-N cap with remainder folded into "other"
    assert "LIMIT 50" in sql


def test_compile_timeseries_adds_bucket():
    sql, params = compile_(make_spec(display={"type": "line"}))
    # 7-day range → day buckets in UTC
    assert "toStartOfDay(event_time, 'UTC')" in sql
    assert params["start_time"] == START


def test_compile_hour_bucket_for_short_range():
    spec = WidgetSpec.model_validate(make_spec(display={"type": "line"}))
    sql, _ = compile_widget_query(
        spec, project_id="p", start_time=datetime(2026, 6, 1), end_time=datetime(2026, 6, 2)
    )
    assert "toStartOfHour(event_time, 'UTC')" in sql


def test_compile_number_no_groupby():
    sql, _ = compile_(make_spec(display={"type": "number"}, breakdown=None))
    assert "GROUP BY" not in sql


def test_compile_histogram():
    spec = make_spec(display={"type": "histogram"}, breakdown=None)
    spec["metric"] = {"measure": "duration_ms", "agg": "avg"}  # agg ignored for histogram
    sql, _ = compile_(spec)
    assert "histogram(20)(toFloat64(duration_ms))" in sql


def test_compile_traces_view_uses_span_agg():
    spec = make_spec(view="traces", filters=[], breakdown="user_id")
    spec["metric"] = {"measure": "error_count", "agg": "sum"}
    spec["display"] = {"type": "bar"}
    sql, _ = compile_(spec)
    assert "countIf(status = 'ERROR')" in sql  # from the traces base relation
    assert "GROUP BY user_id" in sql


def test_unknown_field_raises_with_step():
    with pytest.raises(WidgetSpecError) as e:
        compile_(make_spec(filters=[{"field": "password", "op": "=", "value": "x"}]))
    assert e.value.step == "filters"


def test_disallowed_agg_raises():
    spec = make_spec()
    spec["metric"] = {"measure": "model_name", "agg": "sum"}  # string field
    with pytest.raises(WidgetSpecError) as e:
        compile_(spec)
    assert e.value.step == "metric"


def test_non_groupable_breakdown_raises():
    with pytest.raises(WidgetSpecError) as e:
        compile_(make_spec(breakdown="cost"))
    assert e.value.step == "breakdown"


def test_disallowed_op_for_type_raises():
    with pytest.raises(WidgetSpecError) as e:
        compile_(make_spec(filters=[{"field": "name", "op": ">", "value": "x"}]))
    assert e.value.step == "filters"


# --- histogram shape and value-coercion edge cases ---


def test_histogram_cost_contains_tofloat64():
    """cost is Decimal in ClickHouse; histogram() must receive toFloat64(cost)."""
    spec = make_spec(display={"type": "histogram"}, breakdown=None)
    spec["metric"] = {"measure": "cost", "agg": "sum"}
    sql, _ = compile_(spec)
    assert "toFloat64" in sql
    assert "toFloat64(cost)" in sql


def test_histogram_with_breakdown_raises():
    """Histogram does not support a breakdown dimension."""
    spec = make_spec(display={"type": "histogram"}, breakdown="model_name")
    spec["metric"] = {"measure": "cost", "agg": "sum"}
    with pytest.raises(WidgetSpecError) as e:
        compile_(spec)
    assert e.value.step == "breakdown"


def test_non_numeric_filter_value_raises():
    """A string value on a number-typed filter field must raise step='filters'."""
    filters = [{"field": "cost", "op": ">", "value": "not-a-number"}]
    with pytest.raises(WidgetSpecError) as e:
        compile_(make_spec(filters=filters, breakdown=None))
    assert e.value.step == "filters"


def test_long_range_row_cap():
    """A misaligned 365-day window (noon-to-noon) touches 366 day buckets; LIMIT must cover all of them."""
    spec = WidgetSpec.model_validate(make_spec(display={"type": "line"}))
    start = datetime(2026, 1, 1, 12, 0)
    end = datetime(2027, 1, 1, 12, 0)  # 365 days, noon-anchored — straddles 366 day buckets
    sql, _ = compile_widget_query(spec, project_id="p", start_time=start, end_time=end)
    # Extract the final LIMIT clause (the outermost row cap, not LIMIT 1 BY inside base SQL)
    import re

    matches = re.findall(r"LIMIT (\d+)(?! BY)", sql)
    assert matches, "No outermost LIMIT found in SQL"
    assert int(matches[-1]) >= 366 * 51


def test_breakdown_timeseries_order_by():
    """When breakdown and timeseries are both present, ORDER BY must include both bucket and breakdown."""
    sql, _ = compile_(make_spec(display={"type": "line"}))
    assert "GROUP BY bucket, model_name" in sql
    # WITH FILL sits on the bucket sort key; the breakdown sort key follows it.
    assert "ORDER BY bucket WITH FILL" in sql
    assert "STEP INTERVAL 1 DAY, model_name" in sql


def test_timeseries_fills_empty_buckets_across_window():
    """A timeseries orders by bucket WITH FILL over the full window at the picked step.

    Empty buckets come back as zero rows so the chart's x-axis spans the
    selected range even when stored data starts later.
    """
    sql, _ = compile_(make_spec(display={"type": "line"}, breakdown=None))
    assert (
        "ORDER BY bucket WITH FILL FROM toStartOfDay({start_time:DateTime64(3)}, 'UTC')"
        " TO toStartOfDay({end_time:DateTime64(3)} - INTERVAL 1 MILLISECOND, 'UTC')"
        " + INTERVAL 1 DAY STEP INTERVAL 1 DAY" in sql
    )

    hour_spec = WidgetSpec.model_validate(make_spec(display={"type": "line"}, breakdown=None))
    hour_sql, _ = compile_widget_query(
        hour_spec,
        project_id="proj-1",
        start_time=datetime(2026, 6, 1),
        end_time=datetime(2026, 6, 2),
    )
    assert "WITH FILL FROM toStartOfHour({start_time:DateTime64(3)}, 'UTC')" in hour_sql
    assert "STEP INTERVAL 1 HOUR" in hour_sql


def test_breakdown_column_type_is_pinned_non_nullable():
    """The breakdown select wraps in ifNull so WITH FILL rows default to ''.

    Without the pin, a Nullable breakdown expr (e.g. model_name) would make the
    if() supertype Nullable(String) and fill rows would carry NULL instead of
    the '' the frontend pivot recognizes as a gap row.
    """
    sql, _ = compile_(make_spec(display={"type": "line"}))
    assert "ifNull(if(model_name IN" in sql
    assert "'other'), '') AS model_name" in sql


def test_empty_filter_value_rejected_by_schema():
    """A filter with value '' means the builder row was never completed."""
    with pytest.raises(ValidationError):
        WidgetSpec.model_validate(
            make_spec(filters=[{"field": "model_name", "op": "=", "value": ""}])
        )


def test_reversed_window_rejected():
    """start >= end would otherwise compile a negative LIMIT that CH rejects."""
    spec = WidgetSpec.model_validate(make_spec(display={"type": "line"}))
    with pytest.raises(WidgetSpecError):
        compile_widget_query(spec, project_id="proj-1", start_time=END, end_time=START)
    with pytest.raises(WidgetSpecError):
        compile_widget_query(spec, project_id="proj-1", start_time=START, end_time=START)


def test_mixed_timezone_awareness_normalized():
    """Aware + naive bounds crash datetime subtraction without normalization."""
    spec = WidgetSpec.model_validate(make_spec(display={"type": "line"}))
    sql, params = compile_widget_query(
        spec,
        project_id="proj-1",
        start_time=datetime(2026, 6, 1, tzinfo=UTC),
        end_time=datetime(2026, 6, 8),
    )
    assert "WITH FILL" in sql
    # Params are handed to ClickHouse tz-naive, matching every other endpoint.
    assert params["start_time"].tzinfo is None
    assert params["end_time"].tzinfo is None


def test_pie_and_bar_require_breakdown():
    """Pie/bar collapse to a single unlabeled datum without a breakdown."""
    for display in ("pie", "bar"):
        with pytest.raises(WidgetSpecError):
            compile_(make_spec(display={"type": display}, breakdown=None))


def test_non_timeseries_has_no_fill():
    """Bar/table/number shapes have no time bucket, so no WITH FILL clause."""
    for display in ({"type": "bar"}, {"type": "table"}):
        sql, _ = compile_(make_spec(display=display))
        assert "WITH FILL" not in sql


def test_non_additive_timeseries_metric_is_nullable():
    """Percentile/average time series wrap the metric in toNullable.

    WITH FILL rows carry the column default — 0 for a plain Float64 — which
    would draw a false collapse for aggs where an empty bucket has no value.
    Nullable makes the filled rows NULL, and the chart renders them as gaps.
    """
    for agg in ("avg", "min", "max", "p50", "p75", "p90", "p95", "p99"):
        sql, _ = compile_(
            make_spec(metric={"measure": "duration_ms", "agg": agg}, display={"type": "line"})
        )
        assert "toNullable(" in sql, agg


def test_additive_timeseries_metric_stays_plain():
    """count/sum of an empty bucket genuinely is zero — no Nullable wrapper."""
    for metric in ({"measure": "count", "agg": "count"}, {"measure": "cost", "agg": "sum"}):
        sql, _ = compile_(make_spec(metric=metric, display={"type": "line"}))
        assert "toNullable(" not in sql, metric


def test_non_additive_without_fill_stays_plain():
    """The wrapper exists only for WITH FILL; number/table shapes skip it."""
    for display in ({"type": "number"}, {"type": "table"}):
        sql, _ = compile_(
            make_spec(
                metric={"measure": "duration_ms", "agg": "p95"},
                display=display,
                # Number rejects a breakdown outright; keep the shapes minimal.
                breakdown=None,
            )
        )
        assert "toNullable(" not in sql, display


def test_other_fold_shape():
    """The 'other' fold uses a subquery with LIMIT 50 (MAX_GROUPS)."""
    sql, _ = compile_(make_spec(display={"type": "bar"}))
    assert "'other'" in sql
    assert "IN (SELECT" in sql
    assert "LIMIT 50" in sql


def test_count_measure_with_breakdown():
    """count measure (expr='*') must compile with count(*) and a breakdown."""
    spec = make_spec(display={"type": "bar"})
    spec["metric"] = {"measure": "count", "agg": "count"}
    sql, _ = compile_(spec)
    assert "count(*)" in sql
    assert "GROUP BY model_name" in sql


# --- filter escaping and serialization guards ---


def test_contains_filter_escapes_percent():
    """A contains filter with '%' in the value must bind an escaped ILIKE pattern.

    Without escaping, '50%' would act as a wildcard matching '50' followed by
    anything. The escaped pattern '%50\\%%' makes the '%' match literally.
    """
    filters = [{"field": "name", "op": "contains", "value": "50%"}]
    _, params = compile_(make_spec(filters=filters, breakdown=None))
    assert params["f0"] == "%50\\%%"


def test_bucket_timestamp_serializes_as_iso8601():
    """WidgetQueryResponse rows with datetime values must serialize to ISO-8601.

    The frontend keys on the exact string 'YYYY-MM-DDTHH:MM:SS' (no timezone
    suffix) to identify time-bucket columns. jsonable_encoder (used by FastAPI's
    response pipeline) must produce that format.
    """
    response = WidgetQueryResponse(
        columns=["bucket", "value"],
        rows=[[datetime(2026, 6, 1), 1.0]],
    )
    encoded = jsonable_encoder(response)
    assert encoded["rows"][0][0] == "2026-06-01T00:00:00"


def test_empty_rows_validates_and_serializes():
    """WidgetQueryResponse with no rows is valid and encodes to rows: []."""
    response = WidgetQueryResponse(columns=["value"], rows=[])
    encoded = jsonable_encoder(response)
    assert encoded["rows"] == []


def test_traces_view_null_guards_measures():
    """The traces base relation must NULL-guard measures for span-less traces.

    Rows from the LEFT JOIN where no matching spans exist have sa.trace_id = ''
    (ClickHouse fills String join-key columns with empty string on no match).
    The if(sa.trace_id = '', NULL, ...) pattern converts those to NULL so
    aggregations ignore span-less traces rather than treating the default value
    as real data.
    """
    spec = make_spec(view="traces", filters=[], breakdown=None)
    spec["metric"] = {"measure": "duration_ms", "agg": "avg"}
    spec["display"] = {"type": "number"}
    sql, _ = compile_(spec)
    assert "if(sa.trace_id = ''" in sql


def test_traces_p95_compiles_to_quantile():
    """p95 on traces must compile to quantile(0.95)(...) — pins the agg mapping."""
    spec = make_spec(view="traces", filters=[], breakdown=None)
    spec["metric"] = {"measure": "duration_ms", "agg": "p95"}
    spec["display"] = {"type": "number"}
    sql, _ = compile_(spec)
    assert "quantile(0.95)(duration_ms)" in sql


def test_new_percentiles_compile_to_quantiles():
    """p75/p90 must compile to their quantile levels — pins the agg mapping."""
    for agg, fn in (("p75", "quantile(0.75)"), ("p90", "quantile(0.9)")):
        spec = make_spec(filters=[], breakdown=None, display={"type": "number"})
        spec["metric"] = {"measure": "duration_ms", "agg": agg}
        sql, _ = compile_(spec)
        assert f"{fn}(duration_ms)" in sql, agg


def test_uniq_compiles_to_uniq_exact():
    """uniq must compile to uniqExact — the approximate variant can drift near a threshold."""
    spec = make_spec(filters=[], breakdown=None, display={"type": "number"})
    spec["metric"] = {"measure": "trace_id", "agg": "uniq"}
    sql, _ = compile_(spec)
    assert "uniqExact(trace_id)" in sql


def test_uniq_timeseries_stays_plain():
    """A uniq of an empty bucket genuinely is zero distinct values, so WITH FILL zeros."""
    spec = make_spec(filters=[], breakdown=None, display={"type": "line"})
    spec["metric"] = {"measure": "trace_id", "agg": "uniq"}
    sql, _ = compile_(spec)
    assert "toNullable(" not in sql


def test_tokens_per_second_measure_compiles():
    """The derived throughput field resolves through base_sql like any column."""
    spec = make_spec(filters=[], breakdown=None, display={"type": "number"})
    spec["metric"] = {"measure": "tokens_per_second", "agg": "p95"}
    sql, _ = compile_(spec)
    assert "quantile(0.95)(tokens_per_second)" in sql
    assert "AS tokens_per_second" in sql


def test_tokens_per_second_keeps_sub_second_spans_in_the_aggregate():
    """Dividing by a second-boundary count dropped every sub-second span from the average."""
    spec = make_spec(filters=[], breakdown=None, display={"type": "number"})
    spec["metric"] = {"measure": "tokens_per_second", "agg": "avg"}
    sql, _ = compile_(spec)
    assert "if(duration_ms > 0, total_tokens * 1000 / duration_ms, NULL)" in sql
    assert "dateDiff('second'" not in sql


def test_unique_users_and_sessions_compile_on_traces_view():
    """user_id/session_id are distinct-count measures on the traces view."""
    for field in ("user_id", "session_id"):
        spec = make_spec(view="traces", filters=[], breakdown=None, display={"type": "line"})
        spec["metric"] = {"measure": field, "agg": "uniq"}
        sql, _ = compile_(spec)
        assert f"uniqExact({field})" in sql


def test_user_and_session_keep_dimension_behavior():
    """Adding aggs must not change the fields' existing filter/breakdown role."""
    spec = make_spec(
        view="traces",
        filters=[{"field": "user_id", "op": "=", "value": "u1"}],
        breakdown="session_id",
    )
    sql, params = compile_(spec)
    assert "GROUP BY bucket, session_id" in sql
    assert params["f0"] == "u1"


def test_trace_id_is_not_filterable_or_groupable():
    """A filter or breakdown on one trace id is meaningless."""
    spec = make_spec(breakdown="trace_id")
    with pytest.raises(WidgetSpecError, match="not groupable"):
        compile_(spec)
    spec = make_spec(filters=[{"field": "trace_id", "op": "=", "value": "abc"}], breakdown=None)
    with pytest.raises(WidgetSpecError, match="not allowed"):
        compile_(spec)


def test_number_display_rejects_breakdown():
    """A number tile shows one value; a grouped spec must fail at the breakdown step."""
    spec = WidgetSpec(
        view="spans",
        metric={"measure": "cost", "agg": "sum"},
        breakdown="model_name",
        display={"type": "number"},
    )
    with pytest.raises(WidgetSpecError) as exc:
        compile_widget_query(spec, "p1", START, END)
    assert exc.value.step == "breakdown"


def test_compile_cache_tokens_spans():
    """cache_read_tokens and cache_write_tokens compile correctly for spans."""
    spec = make_spec(view="spans", display={"type": "number"}, breakdown=None)

    spec["metric"] = {"measure": "cache_read_tokens", "agg": "sum"}
    sql, _ = compile_(spec)
    assert "sum(cache_read_tokens)" in sql
    assert "mapContains(usage_details, 'cache_read_tokens')" in sql

    spec["metric"] = {"measure": "cache_write_tokens", "agg": "sum"}
    sql, _ = compile_(spec)
    assert "sum(cache_write_tokens)" in sql
    assert "mapContains(usage_details, 'cache_write_tokens')" in sql


def test_compile_cache_tokens_traces():
    """cache_read_tokens and cache_write_tokens compile correctly for traces."""
    spec = make_spec(view="traces", display={"type": "number"}, breakdown=None, filters=[])

    spec["metric"] = {"measure": "cache_read_tokens", "agg": "sum"}
    sql, _ = compile_(spec)
    assert "sum(cache_read_tokens)" in sql
    assert "mapContains(usage_details, 'cache_read_tokens')" in sql
    assert "if(sa.trace_id = '', NULL, sa.cache_read_tokens)" in sql

    spec["metric"] = {"measure": "cache_write_tokens", "agg": "sum"}
    sql, _ = compile_(spec)
    assert "sum(cache_write_tokens)" in sql
    assert "mapContains(usage_details, 'cache_write_tokens')" in sql
    assert "if(sa.trace_id = '', NULL, sa.cache_write_tokens)" in sql


def test_run_widget_query_sets_execution_guards(monkeypatch):
    """Every widget query runs under the SHARED read bounds, not a private copy.

    What matters is that this read is bound to the same mapping as every other read
    surface — read-only, time-capped, and with a GROUP BY memory ceiling that spills to
    disk instead of OOMing the server. Asserting the mapping the call received is the
    shared one, rather than re-deriving its three fields here, is what makes a future
    edit to the shared bounds carry to this query instead of silently drifting from it.
    """
    fake_result = MagicMock(column_names=["value"], result_rows=[(1,)])
    fake_client = MagicMock()
    fake_client.query.return_value = fake_result
    monkeypatch.setattr(wq, "get_clickhouse_client", lambda: fake_client)

    wq.run_widget_query(
        spec=WidgetSpec.model_validate(make_spec()),
        project_id="p1",
        start_time=START,
        end_time=END,
    )

    settings = fake_client.query.call_args.kwargs["settings"]
    assert settings is READ_QUERY_SETTINGS
    # Spelled out once so the shared mapping cannot be emptied without a failure here.
    assert settings["readonly"] == 1
    assert settings["max_execution_time"] == QUERY_TIMEOUT_S
    assert settings["max_bytes_before_external_group_by"] == GROUP_BY_SPILL_BYTES


def test_is_root_filter_compiles_to_the_root_predicate():
    """`parent_span_id IS NULL`, spelled as the 'true'/'false' string the dropdown offers."""
    spec = make_spec(
        filters=[{"field": "is_root", "op": "=", "value": "true"}],
        breakdown=None,
        display={"type": "number"},
    )
    sql, params = compile_(spec)
    assert "if(parent_span_id IS NULL, 'true', 'false') = {f0:String}" in sql
    assert params["f0"] == "true"
    # The predicate resolves only because the base relation carries the column through.
    assert "parent_span_id," in sql


def test_is_root_expr_runs_against_the_raw_spans_table():
    """The distinct-values endpoint scans `spans` directly, so the expr must name the column."""
    fdef = REGISTRY["spans"].fields["is_root"]
    assert "parent_span_id" in fdef.expr
    assert fdef.expr != "is_root"


def test_is_root_is_filter_only_and_equality_only():
    """Two values, so `contains` would be a slower spelling of `=`."""
    fdef = REGISTRY["spans"].fields["is_root"]
    assert fdef.filter_ops == ("=",)
    assert fdef.aggs == ()
    assert fdef.groupable is False

    with pytest.raises(WidgetSpecError, match="not groupable"):
        compile_(make_spec(breakdown="is_root"))
    with pytest.raises(WidgetSpecError, match="not allowed"):
        compile_(
            make_spec(
                filters=[{"field": "is_root", "op": "contains", "value": "tru"}], breakdown=None
            )
        )


def test_metadata_filter_binds_the_key_as_a_parameter():
    """The key reaches ClickHouse as a bound parameter, exactly like the value."""
    spec = make_spec(
        filters=[{"field": "metadata", "key": "tenant_id", "op": "=", "value": "acme"}],
        breakdown=None,
        display={"type": "number"},
    )
    sql, params = compile_(spec)
    assert "mapContains(metadata_map, {f0k:String})" in sql
    assert "metadata_map[{f0k:String}] = {f0:String}" in sql
    assert params["f0k"] == "tenant_id"
    assert params["f0"] == "acme"
    # The key never appears as SQL text — the whole safety property in one assertion.
    assert "tenant_id" not in sql


def test_metadata_contains_lowers_to_ilike_with_escaped_wildcards():
    """A case-insensitive match whose `%`/`_` are escaped so a literal one matches literally."""
    spec = make_spec(
        filters=[{"field": "metadata", "key": "plan", "op": "contains", "value": "50%"}],
        breakdown=None,
        display={"type": "number"},
    )
    sql, params = compile_(spec)
    assert "metadata_map[{f0k:String}] ILIKE {f0:String}" in sql
    assert params["f0"] == "%50\\%%"


def test_mapcontains_guard_is_not_redundant_with_the_comparison():
    """A map subscript returns the value type's default for an absent key."""
    sql, _ = compile_(
        make_spec(
            filters=[{"field": "metadata", "key": "k", "op": "=", "value": "v"}],
            breakdown=None,
            display={"type": "number"},
        )
    )
    assert "mapContains(metadata_map, {f0k:String}) AND metadata_map" in sql


def test_metadata_column_is_spliced_in_only_when_a_keyed_filter_needs_it():
    """`metadata_map` is the one column the spans no-I/O projection lacks (migration 009)."""
    keyed, _ = compile_(
        make_spec(
            filters=[{"field": "metadata", "key": "k", "op": "=", "value": "v"}],
            breakdown=None,
            display={"type": "number"},
        )
    )
    assert keyed.count(", metadata_map") == 2  # outer projection and the deduped inner scan
    plain, _ = compile_(make_spec(breakdown=None, display={"type": "number"}))
    assert "metadata_map" not in plain
    # The unspliced slot is a SQL line comment, so it leaves no dangling token behind.
    assert "--keyed-columns" in plain


def test_metadata_filter_without_a_key_is_a_spec_error():
    """There is no default map key, so a keyless metadata row is an incomplete filter."""
    with pytest.raises(WidgetSpecError, match="requires a non-empty key"):
        compile_(
            make_spec(
                filters=[{"field": "metadata", "op": "=", "value": "acme"}],
                breakdown=None,
                display={"type": "number"},
            )
        )


def test_over_long_metadata_key_is_a_spec_error():
    """Bounded at the edge, at the same cap the trace-list translator enforces."""
    with pytest.raises(WidgetSpecError, match="exceeds"):
        compile_(
            make_spec(
                filters=[{"field": "metadata", "key": "k" * 257, "op": "=", "value": "v"}],
                breakdown=None,
                display={"type": "number"},
            )
        )


def test_key_on_an_unkeyed_field_is_a_spec_error():
    """A key where none belongs means the caller has the field's shape wrong."""
    with pytest.raises(WidgetSpecError, match="does not take a key"):
        compile_(
            make_spec(
                filters=[{"field": "span_kind", "key": "k", "op": "=", "value": "LLM"}],
                breakdown=None,
                display={"type": "number"},
            )
        )


def test_metadata_is_filterable_but_never_a_dimension_or_a_measure():
    """A Map has no single value to aggregate, and one dimension per key cannot be static."""
    fdef = REGISTRY["spans"].fields["metadata"]
    assert fdef.requires_key is True
    assert fdef.filter_ops == FILTER_OPS_STRING
    assert fdef.groupable is False
    assert fdef.aggs == ()
    with pytest.raises(WidgetSpecError, match="not groupable"):
        compile_(make_spec(breakdown="metadata"))
    with pytest.raises(WidgetSpecError, match="not allowed"):
        compile_(make_spec(metric={"measure": "metadata", "agg": "uniq"}, breakdown=None))


def test_metadata_is_span_scope_only():
    """Alerts are span grain; a trace-scope key matches no span."""
    assert "metadata" not in REGISTRY["traces"].fields
    with pytest.raises(WidgetSpecError, match="Unknown field 'metadata'"):
        compile_(
            make_spec(
                view="traces",
                filters=[{"field": "metadata", "key": "k", "op": "=", "value": "v"}],
                metric={"measure": "cost", "agg": "sum"},
                breakdown=None,
                display={"type": "number"},
            )
        )


# --- explicit bucket width (bucket_seconds) ---


def compile_bucketed(spec_dict, bucket_seconds, start=START, end=END):
    spec = WidgetSpec.model_validate(spec_dict)
    return compile_widget_query(
        spec, project_id="proj-1", start_time=start, end_time=end, bucket_seconds=bucket_seconds
    )


def test_explicit_bucket_compiles_to_tostartofinterval():
    """An explicit width replaces the derived hour/day grain, in UTC like the rest."""
    sql, _ = compile_bucketed(make_spec(display={"type": "line"}), 300, end=datetime(2026, 6, 2))
    assert "toStartOfInterval(event_time, INTERVAL 300 SECOND, 'UTC')" in sql
    assert "STEP INTERVAL 300 SECOND" in sql
    assert "toStartOfHour" not in sql and "toStartOfDay" not in sql


def test_explicit_bucket_cap_sits_exactly_at_max_buckets():
    """The 7-day window is 604800s: 500 buckets of 1210s cover it, 500 of 1209s do not."""
    sql, _ = compile_bucketed(make_spec(display={"type": "line"}), 1210)
    assert "INTERVAL 1210 SECOND" in sql
    with pytest.raises(WidgetSpecError, match="buckets"):
        compile_bucketed(make_spec(display={"type": "line"}), 1209)


def test_explicit_bucket_on_a_display_without_a_time_axis_is_a_spec_error():
    """The width is dead outside a time axis, so it is rejected rather than ignored."""
    cases = [
        ("bar", "model_name"),
        ("pie", "model_name"),
        ("number", None),
        ("table", None),
        ("histogram", None),
    ]
    for display, breakdown in cases:
        with pytest.raises(WidgetSpecError, match="time axis"):
            compile_bucketed(make_spec(display={"type": display}, breakdown=breakdown), 60)


def test_run_widget_query_reports_explicit_bucket_granularity_in_ms(monkeypatch):
    """An explicit width has no name in the hour/day vocabulary, so meta carries milliseconds."""
    fake_result = MagicMock(column_names=["bucket", "value"], result_rows=[])
    fake_client = MagicMock()
    fake_client.query.return_value = fake_result
    monkeypatch.setattr(wq, "get_clickhouse_client", lambda: fake_client)

    out = wq.run_widget_query(
        spec=WidgetSpec.model_validate(make_spec()),
        project_id="p1",
        start_time=START,
        end_time=datetime(2026, 6, 2),
        bucket_seconds=300,
    )
    assert out["meta"]["granularity"] == 300_000
