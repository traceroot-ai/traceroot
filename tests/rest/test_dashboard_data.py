"""Integration tests for the dashboard data read (public route + internal mirror).

One call answers a dashboard's query widgets (up to a cap) for one window. The
dashboard itself comes from the internal Next.js detail route (mocked with
``respx``); each widget's query runs through the engine, patched at the shared
handler module so both surfaces are exercised through the same body.
"""

import threading
import time
from datetime import UTC, datetime, timedelta
from unittest.mock import patch

import respx
from fastapi.testclient import TestClient
from httpx import Response

from rest.main import app
from rest.routers.dashboard_read_common import (
    DASHBOARD_DATA_QUERY_WIDGET_CAP,
    DASHBOARD_DATA_ROW_CAP,
)
from rest.services.widget_query import WidgetSpecError

BASE_URL = "http://localhost:3000"
USER_HEADER = {"Authorization": "Bearer user-session-token"}
KEY_HEADER = {"Authorization": "Bearer tr-some-key"}
USER_OK_BODY = {
    "valid": True,
    "projectId": "proj-A",
    "workspaceId": "ws-1",
    "billingPlan": "enterprise",
    "role": "member",
    "userId": "u1",
}
KEY_OK_BODY = {
    "valid": True,
    "projectId": "proj-A",
    "workspaceId": "ws-1",
    "billingPlan": "enterprise",
    "ingestionBlocked": False,
}
RUN = "rest.routers.dashboard_read_common.run_widget_query"
PATH = "/api/v1/public/dashboards/dash-1/data"

QUERY_SPEC = {
    "view": "spans",
    "filters": [],
    "metric": {"measure": "cost", "agg": "sum"},
    "breakdown": "model_name",
    "display": {"type": "bar"},
}


def _widget(i: int, *, type_: str = "query", spec=None):
    return {
        "id": f"w-{i}",
        "title": f"Widget {i}",
        "type": type_,
        "spec": QUERY_SPEC if spec is None else spec,
        "createTime": "2026-08-01T00:00:00Z",
    }


def _detail(widgets):
    return {
        "dashboard": {
            "id": "dash-1",
            "name": "Latency overview",
            "description": None,
            "isDefault": False,
            "creator": "Ada Lovelace",
            "createTime": "2026-08-01T00:00:00Z",
            "updateTime": "2026-08-02T00:00:00Z",
            "widgets": widgets,
        }
    }


def _mock_key_auth(body=KEY_OK_BODY):
    return respx.post(f"{BASE_URL}/api/internal/validate-api-key").mock(
        return_value=Response(200, json=body)
    )


def _mock_user_auth():
    return respx.post(f"{BASE_URL}/api/internal/validate-user-token").mock(
        return_value=Response(200, json=USER_OK_BODY)
    )


def _mock_detail(body, status_code=200):
    return respx.post(f"{BASE_URL}/api/internal/project-dashboard").mock(
        return_value=Response(status_code, json=body)
    )


def _rows(n: int):
    return {
        "columns": ["model_name", "value"],
        "rows": [[f"m{i}", float(i)] for i in range(n)],
        "meta": {},
    }


def _iso(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


@respx.mock
def test_answers_every_query_widget_in_layout_order_and_lists_feeds():
    _mock_key_auth()
    _mock_detail(
        _detail([_widget(1), _widget(2, type_="trace_feed", spec={"filters": []}), _widget(3)])
    )
    with patch(RUN, return_value=_rows(2)) as run:
        resp = TestClient(app).get(PATH, headers=KEY_HEADER, params={"range": "7d"})
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["dashboard"]["id"] == "dash-1"
    assert body["dashboard"]["name"] == "Latency overview"
    assert [w["id"] for w in body["widgets"]] == ["w-1", "w-2", "w-3"]
    assert [w["status"] for w in body["widgets"]] == ["ok", "skipped", "ok"]
    assert body["widgets"][0]["rows"] == _rows(2)["rows"]
    # The cap reaches the query itself (one extra row signals truncation), so
    # the engine never materializes rows this read would drop.
    assert run.call_args.kwargs["max_rows"] == DASHBOARD_DATA_ROW_CAP + 1
    assert body["widgets"][1]["rows"] is None
    assert (body["queried"], body["skipped"], body["failed"]) == (2, 1, 0)
    assert body["window"]["range"] == "7d"
    assert _iso(body["window"]["end_time"]) - _iso(body["window"]["start_time"]) == timedelta(
        days=7
    )
    # Every query ran for the same window, scoped to the credential's project.
    assert run.call_count == 2
    for call in run.call_args_list:
        assert call.kwargs["project_id"] == "proj-A"
        assert (call.kwargs["end_time"] - call.kwargs["start_time"]) == timedelta(days=7)


@respx.mock
def test_one_widget_failing_does_not_fail_the_dashboard():
    _mock_key_auth()
    _mock_detail(_detail([_widget(1), _widget(2), _widget(3)]))

    # Three widgets, one of which the engine rejects; a side-effect list keeps
    # the outcome deterministic under the fan-out's threads.
    outcomes = [_rows(1), WidgetSpecError("breakdown", "field is not groupable"), _rows(1)]
    with patch(RUN, side_effect=outcomes):
        resp = TestClient(app).get(PATH, headers=KEY_HEADER)
    assert resp.status_code == 200, resp.text
    statuses = [w["status"] for w in resp.json()["widgets"]]
    assert statuses.count("error") == 1 and statuses.count("ok") == 2
    failed = next(w for w in resp.json()["widgets"] if w["status"] == "error")
    assert failed["error"] == "breakdown: field is not groupable"
    assert failed["rows"] is None
    assert resp.json()["failed"] == 1


@respx.mock
def test_an_unexpected_engine_failure_is_reported_generically():
    _mock_key_auth()
    _mock_detail(_detail([_widget(1)]))
    with patch(RUN, side_effect=RuntimeError("clickhouse down")):
        resp = TestClient(app).get(PATH, headers=KEY_HEADER)
    assert resp.status_code == 200
    widget = resp.json()["widgets"][0]
    assert widget["status"] == "error"
    assert widget["error"] == "Widget query failed"


@respx.mock
def test_a_stored_spec_that_no_longer_validates_is_an_error_without_a_query():
    _mock_key_auth()
    _mock_detail(_detail([_widget(1, spec={"view": "spans"})]))
    with patch(RUN, return_value=_rows(1)) as run:
        resp = TestClient(app).get(PATH, headers=KEY_HEADER)
    assert resp.status_code == 200
    widget = resp.json()["widgets"][0]
    assert widget["status"] == "error"
    assert widget["error"].startswith("spec: ")
    run.assert_not_called()


@respx.mock
def test_rows_are_capped_per_widget_and_the_cap_is_reported():
    _mock_key_auth()
    _mock_detail(_detail([_widget(1), _widget(2)]))
    with patch(RUN, side_effect=[_rows(DASHBOARD_DATA_ROW_CAP + 5), _rows(3)]):
        resp = TestClient(app).get(PATH, headers=KEY_HEADER)
    assert resp.status_code == 200
    capped, whole = resp.json()["widgets"]
    assert len(capped["rows"]) == DASHBOARD_DATA_ROW_CAP and capped["truncated"] is True
    assert len(whole["rows"]) == 3 and whole["truncated"] is False


@respx.mock
def test_a_series_returns_every_bucket_uncapped():
    """A trend is answered whole: capping a series would return the oldest buckets of a long window."""
    _mock_key_auth()
    series_spec = {**QUERY_SPEC, "breakdown": None, "display": {"type": "line"}}
    _mock_detail(_detail([_widget(1, spec=series_spec)]))
    rows = {
        "columns": ["bucket", "value"],
        "rows": [[f"2026-06-{1 + i % 28:02d}T00:00:00", float(i)] for i in range(40)],
        "meta": {"granularity": "day"},
    }
    with patch(RUN, return_value=rows) as run:
        resp = TestClient(app).get(PATH, headers=KEY_HEADER, params={"range": "90d"})
    assert resp.status_code == 200, resp.text
    widget = resp.json()["widgets"][0]
    assert len(widget["rows"]) == 40 and widget["truncated"] is False
    assert run.call_args.kwargs["max_rows"] is None


@respx.mock
def test_a_series_over_a_window_with_too_many_buckets_is_an_inline_error():
    """Explicit bounds have no span ceiling; a multi-year breakdown series is refused, not shipped."""
    _mock_key_auth()
    series_spec = {**QUERY_SPEC, "display": {"type": "line"}}
    _mock_detail(_detail([_widget(1, spec=series_spec)]))
    with patch(RUN, return_value=_rows(1)) as run:
        resp = TestClient(app).get(
            PATH,
            headers=KEY_HEADER,
            params={"start_time": "2021-01-01T00:00:00Z", "end_time": "2026-01-01T00:00:00Z"},
        )
    assert resp.status_code == 200, resp.text
    widget = resp.json()["widgets"][0]
    assert widget["status"] == "error" and "run_widget_query" in widget["error"]
    assert run.call_count == 0


@respx.mock
def test_query_widgets_past_the_cap_come_back_as_errors_without_running():
    """One request answers at most the cap; the rest are inline errors, order and count intact."""
    _mock_key_auth()
    n = DASHBOARD_DATA_QUERY_WIDGET_CAP + 2
    _mock_detail(_detail([_widget(i) for i in range(1, n + 1)]))
    with patch(RUN, return_value=_rows(1)) as run:
        resp = TestClient(app).get(PATH, headers=KEY_HEADER, params={"range": "1d"})
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert run.call_count == DASHBOARD_DATA_QUERY_WIDGET_CAP
    assert [w["id"] for w in body["widgets"]] == [f"w-{i}" for i in range(1, n + 1)]
    statuses = [w["status"] for w in body["widgets"]]
    assert statuses == ["ok"] * DASHBOARD_DATA_QUERY_WIDGET_CAP + ["error"] * 2
    assert "query widgets" in body["widgets"][-1]["error"]
    assert (body["queried"], body["failed"]) == (DASHBOARD_DATA_QUERY_WIDGET_CAP, 2)


@respx.mock
def test_a_feed_after_the_cap_is_still_skipped_not_failed():
    """The cap counts query widgets only; a feed anywhere is a skip."""
    _mock_key_auth()
    queries = [_widget(i) for i in range(1, DASHBOARD_DATA_QUERY_WIDGET_CAP + 2)]
    feed = _widget(99, type_="trace_feed", spec={"filters": []})
    _mock_detail(_detail(queries + [feed]))
    with patch(RUN, return_value=_rows(1)) as run:
        resp = TestClient(app).get(PATH, headers=KEY_HEADER, params={"range": "1d"})
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert run.call_count == DASHBOARD_DATA_QUERY_WIDGET_CAP
    assert body["widgets"][-1]["status"] == "skipped"
    assert (body["queried"], body["skipped"], body["failed"]) == (
        DASHBOARD_DATA_QUERY_WIDGET_CAP,
        1,
        1,
    )


@respx.mock
def test_queries_run_concurrently_but_never_more_than_four_at_once():
    _mock_key_auth()
    _mock_detail(_detail([_widget(i) for i in range(8)]))
    lock = threading.Lock()
    in_flight = {"now": 0, "max": 0}

    def slow_run(**_kwargs):
        with lock:
            in_flight["now"] += 1
            in_flight["max"] = max(in_flight["max"], in_flight["now"])
        time.sleep(0.05)
        with lock:
            in_flight["now"] -= 1
        return _rows(1)

    with patch(RUN, side_effect=slow_run):
        started = time.monotonic()
        resp = TestClient(app).get(PATH, headers=KEY_HEADER)
        elapsed = time.monotonic() - started
    assert resp.status_code == 200
    assert in_flight["max"] <= 4
    assert in_flight["max"] > 1, "queries ran one at a time"
    assert elapsed < 8 * 0.05, "queries were not run concurrently"


@respx.mock
def test_dashboard_not_in_project_is_404_passed_through():
    _mock_key_auth()
    _mock_detail({"error": "Dashboard not found"}, status_code=404)
    with patch(RUN) as run:
        resp = TestClient(app).get(PATH, headers=KEY_HEADER)
    assert resp.status_code == 404
    assert resp.json()["detail"] == "Dashboard not found"
    run.assert_not_called()


@respx.mock
def test_range_with_bounds_is_422_before_anything_is_fetched():
    _mock_key_auth()
    detail = _mock_detail(_detail([_widget(1)]))
    params = {
        "range": "7d",
        "start_time": "2026-06-01T00:00:00Z",
        "end_time": "2026-06-08T00:00:00Z",
    }
    with patch(RUN) as run:
        resp = TestClient(app).get(PATH, headers=KEY_HEADER, params=params)
    assert resp.status_code == 422
    assert "either range or start_time/end_time" in str(resp.json()["detail"])
    assert not detail.called
    run.assert_not_called()


@respx.mock
def test_unknown_range_is_a_query_param_validation_error():
    _mock_key_auth()
    resp = TestClient(app).get(PATH, headers=KEY_HEADER, params={"range": "2w"})
    assert resp.status_code == 422
    # The app flattens validation errors to one string naming the parameter.
    assert resp.json()["detail"].startswith("range: Input should be")


@respx.mock
def test_retention_clamp_is_reported_on_the_window():
    _mock_key_auth({**KEY_OK_BODY, "billingPlan": "free"})
    _mock_detail(_detail([_widget(1)]))
    with patch(RUN, return_value=_rows(1)):
        resp = TestClient(app).get(PATH, headers=KEY_HEADER, params={"range": "90d"})
    assert resp.status_code == 200
    window = resp.json()["window"]
    assert window["clamped"] is True
    floor = datetime.now(UTC).replace(tzinfo=None) - timedelta(days=15, hours=2)
    assert _iso(window["start_time"]).replace(tzinfo=None) >= floor


@respx.mock
def test_a_window_entirely_before_retention_is_422_naming_retention():
    # Free plan (15-day retention) with explicit bounds years ago: clamping
    # would invert the window, so the answer is a 422 that names retention —
    # not an engine error blaming bounds that were valid.
    _mock_key_auth({**KEY_OK_BODY, "billingPlan": "free"})
    detail = _mock_detail(_detail([_widget(1)]))
    params = {"start_time": "2020-01-01T00:00:00Z", "end_time": "2020-02-01T00:00:00Z"}
    with patch(RUN) as run:
        resp = TestClient(app).get(PATH, headers=KEY_HEADER, params=params)
    assert resp.status_code == 422
    assert "before the plan's retention cutoff" in resp.json()["detail"]
    assert not detail.called
    run.assert_not_called()


@respx.mock
def test_user_credential_requires_project_id_and_no_auth_is_401():
    _mock_user_auth()
    assert TestClient(app).get(PATH, headers=USER_HEADER).status_code == 400
    assert TestClient(app).get(PATH).status_code == 401


@respx.mock
def test_internal_mirror_answers_like_the_public_route(monkeypatch):
    from shared.config import settings

    monkeypatch.setattr(settings, "internal_api_secret", "test-secret")
    _mock_key_auth()
    _mock_detail(_detail([_widget(1), _widget(2, type_="trace_feed", spec={"filters": []})]))
    params = {"start_time": "2026-06-01T00:00:00Z", "end_time": "2026-06-08T00:00:00Z"}
    with patch(RUN, return_value=_rows(1)):
        public = TestClient(app).get(PATH, headers=KEY_HEADER, params=params)
        internal = TestClient(app).get(
            "/api/v1/projects/proj-A/dashboards/dash-1/data",
            headers={"X-Internal-Secret": "test-secret", "x-user-id": "u1"},
            params=params,
        )
    assert public.status_code == internal.status_code == 200
    assert public.json() == internal.json()
