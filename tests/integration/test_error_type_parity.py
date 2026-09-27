from datetime import UTC, datetime, timedelta

import pytest

import shared.config
from rest.routers.dashboards import get_widget_field_values
from rest.routers.deps import RateLimitedProjectAccess
from rest.routers.traces import get_filter_values
from tests.integration.conftest import DATABASE, PROJECT_A, Gateway, _insert, _span

pytestmark = pytest.mark.integration


@pytest.mark.asyncio
async def test_error_type_filter_parity(gateway: Gateway, monkeypatch: pytest.MonkeyPatch):
    # Patch the settings to connect to the integration test database.
    # The autouse _reset_singletons fixture (tests/conftest.py) ensures
    # the client and service singletons are cleared before and after the test,
    # so they will cleanly re-initialize using these patched settings.
    monkeypatch.setattr(shared.config.settings.clickhouse, "database", DATABASE)

    start = datetime.now(UTC) - timedelta(days=1)

    # Seed data
    s1 = _span(PROJECT_A, "p-sx1", "p-tx1", start)
    s1["error_type"] = "ValueError"
    s1["status"] = "ERROR"

    s2 = _span(PROJECT_A, "p-sx2", "p-tx1", start)
    s2["error_type"] = "TypeError"
    s2["status"] = "ERROR"

    _insert(gateway.admin, "spans", [s1, s2])
    gateway.admin.command("OPTIMIZE TABLE spans FINAL")

    # Mock access
    class MockAccess(RateLimitedProjectAccess):
        def __init__(self):
            self.project_id = PROJECT_A
            self.workspace_id = "ws-test"
            self.user_id = "test-user"
            self.role = "ADMIN"
            self.billing_plan = "free"
            self.project_name = "proj-test"

    access = MockAccess()

    start_param = start - timedelta(days=1)

    # 1. Widget API router function
    widget_resp = await get_widget_field_values(
        request=None,
        response=None,
        project_id=PROJECT_A,
        view="spans",
        field="error_type",
        _access=access,
        start_time=start_param,
        end_time=None,
    )
    widget_values = widget_resp["values"]

    # 2. Trace filter API router function
    trace_resp = await get_filter_values(
        request=None,
        response=None,
        project_id=PROJECT_A,
        field="error_type",
        _access=access,
        start_after=start_param,
        end_before=None,
    )
    trace_values = trace_resp["values"]

    # Assert parity
    assert widget_values == trace_values

    # Assert data was found
    found_values = [v["value"] for v in widget_values]
    assert "TypeError" in found_values, found_values
    assert "ValueError" in found_values, found_values
