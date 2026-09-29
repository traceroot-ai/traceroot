"""Integration tests verifying projection usage for widget queries."""

from __future__ import annotations

from datetime import UTC, datetime

import pytest

from rest.schemas.dashboards import WidgetSpec
from rest.services.widget_query import compile_widget_query
from tests.rest.test_widget_query import make_spec

from .conftest import PROJECT_A, Gateway

pytestmark = pytest.mark.integration


def test_error_type_breakdown_uses_no_io_projection(gateway: Gateway):
    """A widget query grouping by error_type must hit the no-IO projection."""
    spec = WidgetSpec.model_validate(
        make_spec(
            breakdown="error_type",
            metric={"measure": "count", "agg": "count"},
        )
    )
    # The view needs bounds to prune partitions and compile safely.
    start_time = datetime(2026, 9, 1, tzinfo=UTC)
    end_time = datetime(2026, 9, 2, tzinfo=UTC)

    sql, params = compile_widget_query(
        project_id=PROJECT_A,
        spec=spec,
        start_time=start_time,
        end_time=end_time,
    )

    # Verify projection usage via ClickHouse's query plan EXPLAIN.
    # indexes=1 adds projection selection details to the output.
    explain_sql = f"EXPLAIN PLAN indexes=1 {sql}"

    # Run as admin since the read-only account might lack EXPLAIN privileges on the view,
    # or the view abstraction might hide the physical plan from normal users.
    plan = gateway.admin.query(explain_sql, parameters=params)

    # The output is a single column with plan lines.
    output = "\n".join(str(row[0]) for row in plan.result_rows)

    # ClickHouse 25.2 does not print the literal projection name in EXPLAIN PLAN output.
    # Instead, we verify projection usage by checking the PrimaryKey evaluated:
    # The base table's sort prefix is (project_id, trace_id), but the projection's
    # sort prefix is (project_id, span_start_time).
    import re

    assert re.search(r"PrimaryKey\s+Keys:\s+project_id\s+span_start_time", output), (
        f"Expected projection PrimaryKey (project_id, span_start_time), got:\n{output}"
    )
