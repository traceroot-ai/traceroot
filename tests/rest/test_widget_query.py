"""Tests for widget spec models; SQL compiler tests are added by a later task."""

from datetime import UTC, datetime
from typing import get_args

import pytest
from fastapi.encoders import jsonable_encoder
from pydantic import ValidationError

from rest.schemas.dashboards import (
    AggName,
    WidgetFilter,
    WidgetQueryRequest,
    WidgetQueryResponse,
    WidgetSpec,
)
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


# --- New tests for items 8-10 ---


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


# --- Validation-review fix tests ---


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
