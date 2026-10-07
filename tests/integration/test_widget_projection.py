"""Live check that an error_type breakdown reads the spans no-I/O projection.

A projection only serves a query whose columns it all carries (see migration 008), so a
column added to the table but not to the projection would silently push every widget
that touches it back to the base table. This runs the widget compiler's own SQL against
migrations 001 to 013 applied as written and asserts the projection is used.
"""

from __future__ import annotations

from datetime import datetime, timedelta

import pytest

from rest.schemas.dashboards import WidgetSpec
from rest.services.widget_query import compile_widget_query

from .conftest import DATABASE, T0, _insert, _span

pytestmark = pytest.mark.integration

PROJECT_ERR = "proj_err"
PROJECT_VOL = "proj_vol"
PROJECTION = "spans_no_io_by_start_time"
ERROR_TYPES = {"TimeoutError": 3, "ValueError": 2, "unknown": 1}
# Alone in its month so no other case shares the partition. Distinct trace ids per row
# scatter a time window across the base sort key, which is what makes the projection win.
VOL_START = "2026-05-01 00:00:00"
VOL_ROWS = 300_000


@pytest.fixture(scope="module")
def seeded_errors(gateway):
    """Seed one tenant per storage rule and one tenant large enough to be pruned."""
    rows = []
    i = 0
    for error_type, n in ERROR_TYPES.items():
        for _ in range(n):
            row = _span(PROJECT_ERR, f"err-s{i}", "err-t0", T0 + timedelta(seconds=i))
            row["status"] = "ERROR"
            row["error_type"] = error_type
            rows.append(row)
            i += 1
    row = _span(PROJECT_ERR, f"err-s{i}", "err-t0", T0 + timedelta(seconds=i))
    row["error_type"] = ""
    rows.append(row)
    _insert(gateway.admin, "spans", rows)

    gateway.admin.command(
        "INSERT INTO spans (span_id, trace_id, project_id, span_start_time, name, span_kind, "
        "status, error_type, usage_details) "
        "SELECT concat('vol-s', toString(number)), concat('vol-t', toString(cityHash64(number))), "
        f"'{PROJECT_VOL}', toDateTime64('{VOL_START}', 3) + toIntervalSecond(number * 8), "
        "'n', 'LLM', 'ERROR', ['TimeoutError', 'ValueError', 'unknown'][number % 3 + 1], map() "
        f"FROM numbers({VOL_ROWS})"
    )


def _errors_by_type_sql(project: str, start: datetime, end: datetime):
    spec = WidgetSpec.model_validate(
        {
            "view": "spans",
            "filters": [{"field": "status", "op": "=", "value": "ERROR"}],
            "metric": {"measure": "count", "agg": "count"},
            "breakdown": "error_type",
            "display": {"type": "bar"},
        }
    )
    return compile_widget_query(spec, project_id=project, start_time=start, end_time=end)


@pytest.mark.usefixtures("seeded_errors")
def test_error_type_breakdown_returns_seeded_groups(gateway):
    """The widget query groups ERROR spans by error_type; the OK span does not appear."""
    # A day either side: the compiler binds naive UTC datetimes, which the driver reads
    # in the client's local zone, so a tight window would shift by the runner's offset.
    sql, params = _errors_by_type_sql(PROJECT_ERR, T0 - timedelta(days=1), T0 + timedelta(days=1))
    result = gateway.admin.query(sql, parameters=params)
    key, value = result.column_names.index("error_type"), result.column_names.index("value")
    by_type = {row[key]: row[value] for row in result.result_rows}
    assert by_type == ERROR_TYPES


@pytest.mark.usefixtures("seeded_errors")
def test_error_type_breakdown_uses_projection(gateway):
    """A one-hour window over the large tenant is served by the projection, not the table."""
    start = datetime(2026, 5, 15, 0, 0)
    sql, params = _errors_by_type_sql(PROJECT_VOL, start, start + timedelta(hours=1))
    plan = gateway.admin.query(f"EXPLAIN indexes = 1 {sql}", parameters=params)
    lines = [row[0].strip() for row in plan.result_rows]
    assert f"ReadFromMergeTree ({PROJECTION})" in lines, "\n".join(lines)
    assert f"ReadFromMergeTree ({DATABASE}.spans)" not in lines
