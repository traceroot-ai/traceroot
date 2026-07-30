"""Drift test between the trace-filter and widget field registries.

The trace-filter registry (``rest.services.filters.columns``) and the widget
registry (``rest.services.widget_registry``) independently encode SQL for the
same per-trace metrics (cost, tokens, duration, error count) and the same span
dimensions (model, environment). They serve different query shapes — semi-join
predicates vs. view base relations — so they stay separate modules, but the
overlapping expressions must not silently diverge: a user filtering traces by
``duration_ms > 500`` and a widget charting trace duration must measure the
same thing. If one side changes an expression, this test fails and forces the
other side (or this contract) to be updated deliberately.
"""

from rest.services.filters import columns as filter_reg
from rest.services.widget_registry import REGISTRY

WIDGET_TRACES_BASE = REGISTRY["traces"].base_sql
WIDGET_SPANS_FIELDS = REGISTRY["spans"].fields

# Filter-registry aggregate field -> the widget traces view's alias for the same
# per-trace metric. Both sides must compute the alias with the identical aggregate
# expression over spans.
AGGREGATE_FIELD_TO_WIDGET_ALIAS = {
    "cost": "total_cost",
    "total_tokens": "total_tokens",
    "duration_ms": "duration_ms",
    "errors": "error_count",
}


def test_every_overlapping_aggregate_uses_the_same_expression():
    """Each shared per-trace metric's aggregate SQL appears verbatim in the widget
    traces base relation, so filters and widgets measure the same quantity."""
    for field_name in AGGREGATE_FIELD_TO_WIDGET_ALIAS:
        col = filter_reg.get_column(field_name)
        assert col is not None and col.aggregate_expr, f"{field_name} lost its aggregate_expr"
        assert col.aggregate_expr in WIDGET_TRACES_BASE, (
            f"filter field '{field_name}' computes `{col.aggregate_expr}` but the widget "
            "traces view no longer contains that expression — the two registries drifted"
        )


def test_widget_traces_view_still_exposes_the_shared_aliases():
    """The alias mapping above is only meaningful while the widget view keeps those
    fields; losing one silently would hollow out the expression check."""
    traces_fields = REGISTRY["traces"].fields
    for alias in ("cost", "total_tokens", "duration_ms", "error_count"):
        assert alias in traces_fields, f"widget traces view dropped shared field '{alias}'"


def test_membership_filter_fields_are_widget_span_dimensions():
    """Span attributes filterable on the trace list (model, environment) exist in the
    widget spans view as string dimensions over the same physical column."""
    for col in filter_reg.FILTER_COLUMNS:
        if col.level is not filter_reg.FilterLevel.SPAN_MEMBERSHIP:
            continue
        widget_field = WIDGET_SPANS_FIELDS.get(col.name)
        assert widget_field is not None, f"widget spans view lacks filter field '{col.name}'"
        assert widget_field.type == "string"
        # Same physical column: the widget expr is the bare column name the filter
        # semi-join scans, so both read identical stored values.
        assert widget_field.expr == col.name
