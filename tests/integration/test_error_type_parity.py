from datetime import UTC, datetime, timedelta

import pytest
from starlette.requests import Request
from starlette.responses import Response

import shared.config
from rest.rate_limit import set_rate_limit_identity
from rest.routers.dashboards import get_widget_field_values
from rest.routers.deps import ProjectAccessInfo
from rest.routers.traces import get_filter_values
from tests.integration.conftest import (
    ADMIN_PASSWORD,
    ADMIN_USER,
    DATABASE,
    HOST,
    PORT,
    Gateway,
    _insert,
    _span,
)

pytestmark = pytest.mark.integration

PROJECT_PARITY = "proj_parity"


@pytest.mark.asyncio
async def test_error_type_filter_parity(gateway: Gateway, monkeypatch: pytest.MonkeyPatch):
    # Patch the settings to connect to the integration test database using active test credentials.
    # The autouse _reset_singletons fixture (tests/conftest.py) ensures
    # the client and service singletons are cleared before and after the test,
    # so they will cleanly re-initialize using these patched settings.
    import db.clickhouse.client as ch_mod
    import rest.services.trace_discovery as td_mod

    monkeypatch.setattr(shared.config.settings.clickhouse, "host", HOST)
    monkeypatch.setattr(shared.config.settings.clickhouse, "port", PORT)
    monkeypatch.setattr(shared.config.settings.clickhouse, "database", DATABASE)
    monkeypatch.setattr(shared.config.settings.clickhouse, "user", ADMIN_USER)
    monkeypatch.setattr(shared.config.settings.clickhouse, "password", ADMIN_PASSWORD)
    monkeypatch.setattr(ch_mod, "_client", None)
    monkeypatch.setattr(td_mod, "_service", None)

    start = datetime.now(UTC) - timedelta(days=1)

    # Seed data
    s1 = _span(PROJECT_PARITY, "parity-s1", "parity-t1", start)
    s1["error_type"] = "ValueError"
    s1["status"] = "ERROR"

    s2 = _span(PROJECT_PARITY, "parity-s2", "parity-t1", start)
    s2["error_type"] = "TypeError"
    s2["status"] = "ERROR"

    try:
        _insert(gateway.admin, "spans", [s1, s2])
        gateway.admin.command("OPTIMIZE TABLE spans FINAL")

        # Mock access
        access = ProjectAccessInfo(
            project_id=PROJECT_PARITY,
            user_id="test-user",
            role="ADMIN",
            workspace_id="ws-test",
            billing_plan="free",
        )

        start_param = start - timedelta(days=1)

        # 1. Widget API router function
        widget_req = Request(
            {
                "type": "http",
                "method": "GET",
                "path": f"/api/v1/projects/{PROJECT_PARITY}/widgets/field-values/spans/error_type",
                "headers": [],
                "state": {},
            }
        )
        set_rate_limit_identity(
            widget_req, access.workspace_id, access.billing_plan, access.user_id
        )
        widget_res = Response()

        widget_resp = await get_widget_field_values(
            request=widget_req,
            response=widget_res,
            project_id=PROJECT_PARITY,
            view="spans",
            field="error_type",
            _access=access,
            start_time=start_param,
            end_time=None,
        )
        widget_values = widget_resp["values"]

        # 2. Trace filter API router function
        trace_req = Request(
            {
                "type": "http",
                "method": "GET",
                "path": f"/api/v1/projects/{PROJECT_PARITY}/traces/filter-values/error_type",
                "headers": [],
                "state": {},
            }
        )
        set_rate_limit_identity(trace_req, access.workspace_id, access.billing_plan, access.user_id)
        trace_res = Response()

        trace_resp = await get_filter_values(
            request=trace_req,
            response=trace_res,
            project_id=PROJECT_PARITY,
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
    finally:
        try:
            gateway.admin.command(f"ALTER TABLE spans DELETE WHERE project_id = '{PROJECT_PARITY}'")
            gateway.admin.command("OPTIMIZE TABLE spans FINAL")
        except Exception:
            pass
        ch_mod._client = None
        td_mod._service = None
