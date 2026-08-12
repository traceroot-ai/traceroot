"""Unit tests for the trace-filter meta endpoints and the discovery queries.

Covers ``GET /traces/filter-fields`` (registry serialization),
``GET /traces/filter-values/{field}`` (distinct categorical values) and
``GET /traces/metadata-keys`` (metadata key discovery), plus the
``TraceDiscoveryService`` queries + cache behind them. Uses TestClient with mocked
dependencies — no ClickHouse needed.
"""

from datetime import UTC, datetime, timedelta
from unittest.mock import MagicMock

import pytest
from fastapi import HTTPException, status
from fastapi.testclient import TestClient

from rest.main import app
from rest.routers.deps import ProjectAccessInfo, get_project_access
from rest.services.filters import columns as reg


def _now_naive() -> datetime:
    return datetime.now(UTC).replace(tzinfo=None)


def _free_clamp_floor() -> datetime:
    """Lower edge a clamped free-plan (15-day retention) start must land at or after.

    Allows generous slack for the cutoff's 1h buffer and the test's own runtime.
    """
    return _now_naive() - timedelta(days=15, hours=2)


def _client_for_plan(mock_discovery, billing_plan: str) -> TestClient:
    """TestClient whose project access reports ``billing_plan``, with discovery mocked."""

    async def mock_get_access(project_id: str, x_user_id=None):
        return ProjectAccessInfo(
            project_id=project_id,
            user_id="test-user",
            role="ADMIN",
            workspace_id="ws-test",
            billing_plan=billing_plan,
        )

    app.dependency_overrides[get_project_access] = mock_get_access

    import rest.routers.traces as traces_mod

    traces_mod.get_trace_discovery_service = lambda: mock_discovery
    return TestClient(app)


@pytest.fixture()
def mock_discovery():
    return MagicMock()


@pytest.fixture()
def client(mock_discovery):
    import rest.routers.traces as traces_mod

    original = traces_mod.get_trace_discovery_service
    yield _client_for_plan(mock_discovery, "enterprise")
    traces_mod.get_trace_discovery_service = original
    app.dependency_overrides.clear()


@pytest.fixture()
def free_plan_client(mock_discovery):
    """Free plan (15-day retention) — exercises the retention clamp path."""
    import rest.routers.traces as traces_mod

    original = traces_mod.get_trace_discovery_service
    yield _client_for_plan(mock_discovery, "free")
    traces_mod.get_trace_discovery_service = original
    app.dependency_overrides.clear()


class TestFilterFields:
    def test_returns_every_registry_field(self, client):
        resp = client.get("/api/v1/projects/p1/traces/filter-fields")
        assert resp.status_code == 200
        fields = resp.json()["fields"]
        assert {f["field"] for f in fields} == {c.name for c in reg.FILTER_COLUMNS}

    def test_serializes_field_shape_from_registry(self, client):
        fields = {
            f["field"]: f
            for f in client.get("/api/v1/projects/p1/traces/filter-fields").json()["fields"]
        }

        model = fields["model_name"]
        assert model["type"] == "categorical"
        assert model["level"] == "SPAN_MEMBERSHIP"
        assert model["operators"] == ["in"]
        assert model["value_source"] == "distinct_query"
        assert model["enum_values"] == []

        cost = fields["cost"]
        assert cost["type"] == "numeric"
        assert cost["operators"] == ["eq", "gt", "gte", "lt", "lte"]
        assert cost["value_source"] == "range"
        # Integer-typed fields are flagged so the UI restricts them to whole numbers;
        # cost (Decimal) and model (String) are not.
        assert fields["total_tokens"]["integer"] is True
        assert fields["duration_ms"]["integer"] is True
        assert fields["errors"]["integer"] is True
        assert cost["integer"] is False
        assert model["integer"] is False

    def test_serializes_requires_key_so_the_builder_renders_a_key_control(self, client):
        """The client learns which field takes a key from the registry response rather
        than hard-coding the field name.

        The bit survives on the wire even though the backend derives it from the level,
        because the level is serialized as an opaque string the client never interprets:
        without the boolean, deciding whether to render the key control would mean
        branching on a backend enum's spelling in the UI.
        """
        fields = {
            f["field"]: f
            for f in client.get("/api/v1/projects/p1/traces/filter-fields").json()["fields"]
        }

        assert fields["metadata"]["requires_key"] is True
        assert fields["metadata"]["level"] == "KEYED_MAP"
        assert fields["metadata"]["operators"] == ["eq", "contains"]
        assert fields["metadata"]["value_source"] == "free_text"
        for name in ("model_name", "environment", "cost", "trace_id", "errors"):
            assert fields[name]["requires_key"] is False


class TestFilterValues:
    def test_model_name_returns_values_by_frequency(self, client, mock_discovery):
        mock_discovery.get_distinct_span_values.return_value = [
            {"value": "gpt-4", "count": 10},
            {"value": "claude-opus-4.8", "count": 4},
        ]
        resp = client.get("/api/v1/projects/p1/traces/filter-values/model_name")
        assert resp.status_code == 200
        body = resp.json()
        assert body["field"] == "model_name"
        assert body["values"][0] == {"value": "gpt-4", "count": 10}
        kw = mock_discovery.get_distinct_span_values.call_args.kwargs
        assert kw["project_id"] == "p1"
        assert kw["column"] == "model_name"

    def test_start_after_is_threaded_to_the_service(self, client, mock_discovery):
        mock_discovery.get_distinct_span_values.return_value = []
        resp = client.get(
            "/api/v1/projects/p1/traces/filter-values/environment?start_after=2026-06-01T00:00:00"
        )
        assert resp.status_code == 200
        assert mock_discovery.get_distinct_span_values.call_args.kwargs["start_after"] == datetime(
            2026, 6, 1, 0, 0, 0
        )

    def test_end_before_is_threaded_to_the_service(self, client, mock_discovery):
        mock_discovery.get_distinct_span_values.return_value = []
        resp = client.get(
            "/api/v1/projects/p1/traces/filter-values/environment"
            "?start_after=2026-06-01T00:00:00&end_before=2026-06-02T00:00:00"
        )
        assert resp.status_code == 200
        kw = mock_discovery.get_distinct_span_values.call_args.kwargs
        assert kw["start_after"] == datetime(2026, 6, 1, 0, 0, 0)
        assert kw["end_before"] == datetime(2026, 6, 2, 0, 0, 0)

    def test_unknown_field_is_404(self, client, mock_discovery):
        resp = client.get("/api/v1/projects/p1/traces/filter-values/not_a_field")
        assert resp.status_code == 404
        mock_discovery.get_distinct_span_values.assert_not_called()

    def test_numeric_field_is_rejected(self, client, mock_discovery):
        resp = client.get("/api/v1/projects/p1/traces/filter-values/cost")
        assert resp.status_code == 400
        mock_discovery.get_distinct_span_values.assert_not_called()


class TestGetDistinctSpanValues:
    def _service(self, monkeypatch, mock_client):
        import rest.services.trace_discovery as discovery_mod

        monkeypatch.setattr(discovery_mod, "get_clickhouse_client", lambda: mock_client)
        return discovery_mod.TraceDiscoveryService()

    def test_builds_grouped_project_scoped_query(self, monkeypatch):
        mock_client = MagicMock()
        mock_client.query.return_value.result_rows = [("gpt-4", 10), ("claude", 5)]
        svc = self._service(monkeypatch, mock_client)

        out = svc.get_distinct_span_values(project_id="p1", column="model_name")

        assert out == [
            {"value": "gpt-4", "count": 10},
            {"value": "claude", "count": 5},
        ]
        sql, kwargs = mock_client.query.call_args
        query_text = sql[0]
        assert "FROM spans" in query_text
        assert "GROUP BY" in query_text
        assert "model_name" in query_text
        assert "project_id = {project_id:String}" in query_text
        params = kwargs["parameters"]
        assert params["project_id"] == "p1"

    def test_excludes_detector_self_traces(self, monkeypatch):
        # A self-trace carries its own name, environment and model, so an unguarded
        # scan offers them as options in the customer's own dropdown. Asserted via the
        # helper, not a literal: changing the predicate shouldn't look like a lost guard.
        from rest.services.trace_reader import customer_traffic_only

        mock_client = MagicMock()
        mock_client.query.return_value.result_rows = []
        svc = self._service(monkeypatch, mock_client)

        svc.get_distinct_span_values(project_id="p1", column="model_name")

        assert customer_traffic_only() in mock_client.query.call_args[0][0]

    def test_no_window_defaults_a_lookback_bound_never_unbounded(self, monkeypatch):
        """A direct caller passing no window must not trigger an all-time span scan:
        a default lower bound is injected (symmetric with the filtered trace list)."""
        from datetime import UTC, datetime, timedelta

        from rest.services.trace_reader import DEFAULT_SPAN_SCAN_LOOKBACK_HOURS

        mock_client = MagicMock()
        mock_client.query.return_value.result_rows = []
        svc = self._service(monkeypatch, mock_client)

        before = datetime.now(UTC).replace(tzinfo=None)
        svc.get_distinct_span_values(project_id="p1", column="model_name")
        after = datetime.now(UTC).replace(tzinfo=None)

        sql, kwargs = mock_client.query.call_args
        assert "span_start_time >= {start_after:DateTime64(3)}" in sql[0]
        lo, hi = (
            before - timedelta(hours=DEFAULT_SPAN_SCAN_LOOKBACK_HOURS),
            after - timedelta(hours=DEFAULT_SPAN_SCAN_LOOKBACK_HOURS),
        )
        assert lo <= kwargs["parameters"]["start_after"] <= hi

    def test_end_before_only_defaults_start_relative_to_it(self, monkeypatch):
        from datetime import datetime, timedelta

        from rest.services.trace_reader import DEFAULT_SPAN_SCAN_LOOKBACK_HOURS

        mock_client = MagicMock()
        mock_client.query.return_value.result_rows = []
        svc = self._service(monkeypatch, mock_client)

        end = datetime(2026, 6, 2, 12, 0, 0)
        svc.get_distinct_span_values(project_id="p1", column="model_name", end_before=end)

        params = mock_client.query.call_args.kwargs["parameters"]
        assert params["start_after"] == end - timedelta(hours=DEFAULT_SPAN_SCAN_LOOKBACK_HOURS)

    def test_start_after_adds_a_time_bound(self, monkeypatch):
        mock_client = MagicMock()
        mock_client.query.return_value.result_rows = []
        svc = self._service(monkeypatch, mock_client)

        svc.get_distinct_span_values(
            project_id="p1", column="model_name", start_after=datetime(2026, 6, 1)
        )
        sql, kwargs = mock_client.query.call_args
        assert "span_start_time >= {start_after:DateTime64(3)}" in sql[0]
        assert kwargs["parameters"]["start_after"] is not None

    def test_end_before_adds_an_upper_time_bound(self, monkeypatch):
        mock_client = MagicMock()
        mock_client.query.return_value.result_rows = []
        svc = self._service(monkeypatch, mock_client)

        svc.get_distinct_span_values(
            project_id="p1",
            column="model_name",
            start_after=datetime(2026, 6, 1),
            end_before=datetime(2026, 6, 2),
        )
        sql, kwargs = mock_client.query.call_args
        assert "span_start_time < {end_before:DateTime64(3)}" in sql[0]
        assert kwargs["parameters"]["end_before"] == datetime(2026, 6, 2)

    def test_subminute_window_jitter_reuses_the_cache(self, monkeypatch):
        """Sub-minute jitter in the window (the UI recomputes "now" each render) must
        share one cache entry, so it can't trivially bypass the cache."""
        mock_client = MagicMock()
        mock_client.query.return_value.result_rows = [("gpt-4", 10)]
        svc = self._service(monkeypatch, mock_client)

        svc.get_distinct_span_values(
            project_id="p1", column="model_name", start_after=datetime(2026, 6, 1, 0, 0, 5)
        )
        svc.get_distinct_span_values(
            project_id="p1", column="model_name", start_after=datetime(2026, 6, 1, 0, 0, 45)
        )
        mock_client.query.assert_called_once()  # same minute → one heavy GROUP BY

    def test_results_are_cached_per_project_field_window(self, monkeypatch):
        mock_client = MagicMock()
        mock_client.query.return_value.result_rows = [("gpt-4", 10)]
        svc = self._service(monkeypatch, mock_client)

        first = svc.get_distinct_span_values(project_id="p1", column="model_name")
        second = svc.get_distinct_span_values(project_id="p1", column="model_name")

        assert first == second
        mock_client.query.assert_called_once()  # second call served from cache

    def test_query_excludes_null_and_empty_values(self, monkeypatch):
        mock_client = MagicMock()
        mock_client.query.return_value.result_rows = []
        svc = self._service(monkeypatch, mock_client)

        svc.get_distinct_span_values(project_id="p1", column="model_name")
        query_text = mock_client.query.call_args[0][0]
        assert "model_name AS value" in query_text
        assert "value IS NOT NULL" in query_text
        assert "value != ''" in query_text  # blanks aren't offered as options
        # Deduped to the latest ReplacingMergeTree version per span before counting.
        assert "LIMIT 1 BY project_id, trace_id, span_id" in query_text

    def test_cache_is_bounded(self, monkeypatch):
        from rest.services.trace_discovery import DISCOVERY_CACHE_MAX

        mock_client = MagicMock()
        mock_client.query.return_value.result_rows = []
        svc = self._service(monkeypatch, mock_client)

        # Far more distinct cache keys than the cap; size must stay bounded.
        for i in range(DISCOVERY_CACHE_MAX + 50):
            svc.get_distinct_span_values(project_id=f"p{i}", column="model_name")
        assert len(svc._discovery_cache) <= DISCOVERY_CACHE_MAX


class TestGetDistinctTraceValues:
    """The traces-table variant that powers the widget builder's traces-view dropdowns."""

    def _service(self, monkeypatch, mock_client):
        import rest.services.trace_discovery as discovery_mod

        monkeypatch.setattr(discovery_mod, "get_clickhouse_client", lambda: mock_client)
        return discovery_mod.TraceDiscoveryService()

    def test_builds_grouped_project_scoped_traces_query(self, monkeypatch):
        mock_client = MagicMock()
        mock_client.query.return_value.result_rows = [("u-1", 8), ("u-2", 3)]
        svc = self._service(monkeypatch, mock_client)

        out = svc.get_distinct_trace_values(project_id="p1", column="user_id")

        assert out == [
            {"value": "u-1", "count": 8},
            {"value": "u-2", "count": 3},
        ]
        sql, kwargs = mock_client.query.call_args
        query_text = sql[0]
        assert "FROM traces" in query_text
        assert "GROUP BY" in query_text
        assert "user_id AS value" in query_text
        assert "project_id = {project_id:String}" in query_text
        # Deduped to the latest ReplacingMergeTree version per trace before counting.
        assert "LIMIT 1 BY project_id, trace_id" in query_text
        assert kwargs["parameters"]["project_id"] == "p1"

    def test_excludes_detector_self_traces(self, monkeypatch):
        # Same shared helper as the spans wrapper, asserted separately: both wrappers
        # feed customer-facing dropdowns, so a guard lost on either one leaks.
        from rest.services.trace_reader import customer_traffic_only

        mock_client = MagicMock()
        mock_client.query.return_value.result_rows = []
        svc = self._service(monkeypatch, mock_client)

        svc.get_distinct_trace_values(project_id="p1", column="name")

        assert customer_traffic_only() in mock_client.query.call_args[0][0]

    def test_no_window_defaults_a_lookback_bound_never_unbounded(self, monkeypatch):
        """Same never-scan-all-time rule as the span variant, on trace_start_time."""
        from datetime import UTC, timedelta

        from rest.services.trace_reader import DEFAULT_SPAN_SCAN_LOOKBACK_HOURS

        mock_client = MagicMock()
        mock_client.query.return_value.result_rows = []
        svc = self._service(monkeypatch, mock_client)

        before = datetime.now(UTC).replace(tzinfo=None)
        svc.get_distinct_trace_values(project_id="p1", column="user_id")
        after = datetime.now(UTC).replace(tzinfo=None)

        sql, kwargs = mock_client.query.call_args
        assert "trace_start_time >= {start_after:DateTime64(3)}" in sql[0]
        lo, hi = (
            before - timedelta(hours=DEFAULT_SPAN_SCAN_LOOKBACK_HOURS),
            after - timedelta(hours=DEFAULT_SPAN_SCAN_LOOKBACK_HOURS),
        )
        assert lo <= kwargs["parameters"]["start_after"] <= hi

    def test_window_bounds_are_applied(self, monkeypatch):
        mock_client = MagicMock()
        mock_client.query.return_value.result_rows = []
        svc = self._service(monkeypatch, mock_client)

        svc.get_distinct_trace_values(
            project_id="p1",
            column="environment",
            start_after=datetime(2026, 6, 1),
            end_before=datetime(2026, 6, 2),
        )
        sql, kwargs = mock_client.query.call_args
        assert "trace_start_time >= {start_after:DateTime64(3)}" in sql[0]
        assert "trace_start_time < {end_before:DateTime64(3)}" in sql[0]
        assert kwargs["parameters"]["end_before"] == datetime(2026, 6, 2)

    def test_span_and_trace_caches_do_not_collide(self, monkeypatch):
        """Same column name on both tables must be two cache entries, not one."""
        mock_client = MagicMock()
        mock_client.query.return_value.result_rows = [("prod", 5)]
        svc = self._service(monkeypatch, mock_client)

        svc.get_distinct_span_values(project_id="p1", column="environment")
        svc.get_distinct_trace_values(project_id="p1", column="environment")
        assert mock_client.query.call_count == 2  # one real query per table

    def test_results_are_cached(self, monkeypatch):
        mock_client = MagicMock()
        mock_client.query.return_value.result_rows = [("prod", 5)]
        svc = self._service(monkeypatch, mock_client)

        first = svc.get_distinct_trace_values(project_id="p1", column="environment")
        second = svc.get_distinct_trace_values(project_id="p1", column="environment")
        assert first == second
        mock_client.query.assert_called_once()


class TestMetadataKeys:
    """``GET /traces/metadata-keys`` — the one discovery answer behind the filter's key
    combobox and the trace list's metadata column picker."""

    _URL = "/api/v1/projects/p1/traces/metadata-keys"

    def test_returns_keys_with_counts_in_the_service_order(self, client, mock_discovery):
        mock_discovery.get_distinct_metadata_keys.return_value = [
            {"value": "tenant_id", "count": 120},
            {"value": "release", "count": 8},
        ]

        resp = client.get(self._URL)

        assert resp.status_code == 200
        assert resp.json()["keys"] == [
            {"value": "tenant_id", "count": 120},
            {"value": "release", "count": 8},
        ]
        assert mock_discovery.get_distinct_metadata_keys.call_args.kwargs["project_id"] == "p1"

    def test_window_params_are_threaded_to_the_service(self, client, mock_discovery):
        mock_discovery.get_distinct_metadata_keys.return_value = []

        resp = client.get(
            f"{self._URL}?start_after=2026-06-01T00:00:00&end_before=2026-06-02T00:00:00"
        )

        assert resp.status_code == 200
        kw = mock_discovery.get_distinct_metadata_keys.call_args.kwargs
        assert kw["start_after"] == datetime(2026, 6, 1, 0, 0, 0)
        assert kw["end_before"] == datetime(2026, 6, 2, 0, 0, 0)

    def test_response_carries_only_the_keys(self, client, mock_discovery):
        """The response is the key list and nothing else. It used to echo the window back,
        which no consumer read, and which meant resolving the window twice — once in the
        router and once in the service — with only convention keeping the echoed bounds
        equal to the scanned ones."""
        mock_discovery.get_distinct_metadata_keys.return_value = []

        body = client.get(
            f"{self._URL}?start_after=2026-06-01T00:00:00&end_before=2026-06-02T00:00:00"
        ).json()

        assert set(body) == {"keys"}
        assert "start_after" not in body
        assert "end_before" not in body

    def test_omitted_bounds_reach_the_service_as_none(self, client, mock_discovery):
        """The router does not resolve the window: an open-ended request passes ``None``
        through and the service applies the one discovery window rule (which defaults the
        lower bound rather than scanning all time — asserted on the service itself)."""
        mock_discovery.get_distinct_metadata_keys.return_value = []

        resp = client.get(self._URL)

        assert resp.status_code == 200
        kw = mock_discovery.get_distinct_metadata_keys.call_args.kwargs
        assert kw["start_after"] is None
        assert kw["end_before"] is None

    def test_out_of_window_start_is_clamped_for_limited_plan(
        self, free_plan_client, mock_discovery
    ):
        """A window reaching past the plan's retention is pulled up to the cutoff, exactly
        as ``/filter-values/{field}`` clamps it. Without this a caller could enumerate the
        metadata key names of data the plan no longer grants access to — key names carry
        customer vocabulary (tenant, customer and account identifiers), so the leak is real
        even though no values come back with them."""
        mock_discovery.get_distinct_metadata_keys.return_value = []
        old = (_now_naive() - timedelta(days=365)).isoformat()

        resp = free_plan_client.get(f"{self._URL}?start_after={old}")

        assert resp.status_code == 200
        clamped = mock_discovery.get_distinct_metadata_keys.call_args.kwargs["start_after"]
        assert clamped > datetime(2020, 1, 2)  # not the ancient input
        assert clamped >= _free_clamp_floor()  # pulled up to ~ now - 15 days

    def test_missing_start_is_clamped_for_limited_plan(self, free_plan_client, mock_discovery):
        """An omitted lower bound would otherwise reach the service as ``None`` and be
        defaulted to a lookback that owes nothing to the plan; the clamp bounds it first."""
        mock_discovery.get_distinct_metadata_keys.return_value = []

        resp = free_plan_client.get(self._URL)

        assert resp.status_code == 200
        clamped = mock_discovery.get_distinct_metadata_keys.call_args.kwargs["start_after"]
        assert clamped is not None
        assert clamped >= _free_clamp_floor()

    def test_the_clamp_matches_the_sibling_filter_values_endpoint(
        self, free_plan_client, mock_discovery
    ):
        """Same plan, same requested window, same resulting lower bound on both discovery
        endpoints — one clamp reused, not two implementations that could drift."""
        mock_discovery.get_distinct_metadata_keys.return_value = []
        mock_discovery.get_distinct_span_values.return_value = []
        old = (_now_naive() - timedelta(days=365)).isoformat()

        free_plan_client.get(f"{self._URL}?start_after={old}")
        keys_start = mock_discovery.get_distinct_metadata_keys.call_args.kwargs["start_after"]
        free_plan_client.get(
            f"/api/v1/projects/p1/traces/filter-values/model_name?start_after={old}"
        )
        values_start = mock_discovery.get_distinct_span_values.call_args.kwargs["start_after"]

        assert abs((keys_start - values_start).total_seconds()) < 2

    def test_unlimited_plan_window_reaches_the_service_verbatim(self, client, mock_discovery):
        """The clamp is a retention gate, not a window rewrite: an unlimited plan's
        requested bounds pass through untouched."""
        mock_discovery.get_distinct_metadata_keys.return_value = []

        resp = client.get(f"{self._URL}?start_after=2020-01-01T00:00:00")

        assert resp.status_code == 200
        kw = mock_discovery.get_distinct_metadata_keys.call_args.kwargs
        assert kw["start_after"] == datetime(2020, 1, 1, 0, 0, 0)

    def test_denied_project_access_is_not_answered(self, mock_discovery):
        """Discovery reads another tenant's spans if it skips the access check, so it
        carries the same dependency as every other trace route."""

        async def deny_access(project_id: str, x_user_id=None):
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="No access")

        app.dependency_overrides[get_project_access] = deny_access
        import rest.routers.traces as traces_mod

        original = traces_mod.get_trace_discovery_service
        traces_mod.get_trace_discovery_service = lambda: mock_discovery
        try:
            resp = TestClient(app).get(self._URL)
        finally:
            traces_mod.get_trace_discovery_service = original
            app.dependency_overrides.clear()

        assert resp.status_code == 403
        mock_discovery.get_distinct_metadata_keys.assert_not_called()

    def test_route_is_registered_with_the_shared_read_limiter(self):
        """Discovery is a full-project GROUP BY, so it must share the per-workspace read
        budget rather than ship undecorated."""
        from rest.rate_limit import limiter

        assert "rest.routers.traces.get_metadata_keys" in limiter._dynamic_route_limits

    def test_success_returns_200_with_headers_when_limiter_enabled(
        self, client, mock_discovery, monkeypatch
    ):
        """With the limiter enabled (cloud), the route must still 200 and carry the
        X-RateLimit-* headers — i.e. it declares the ``response`` param slowapi needs for
        header injection (missing it 500s every call). The test env disables the limiter,
        so this drives the real route through an enabled module limiter."""
        import rest.rate_limit as rate_limit

        monkeypatch.setattr(rate_limit.limiter, "enabled", True)
        mock_discovery.get_distinct_metadata_keys.return_value = []

        resp = client.get(self._URL)

        assert resp.status_code == 200, resp.text
        assert "X-RateLimit-Limit" in resp.headers


class TestGetDistinctMetadataKeys:
    """Metadata key discovery reuses the distinct-values machinery wholesale: the same
    defaulted-and-both-ends window, dedup before counting, frequency order, cap and
    minute-floored cache. A suggested key must obey the same rule as a suggested value —
    the active window must never be the reason a suggested option returns zero rows.

    It answers for BOTH surfaces it feeds: the filter's key combobox and the trace list's
    column picker. A tag can be attached at trace scope or span scope and the two key
    spaces are disjoint, so scanning one table would leave the other's keys unsuggestable."""

    def _service(self, monkeypatch, mock_client):
        import rest.services.trace_discovery as discovery_mod

        monkeypatch.setattr(discovery_mod, "get_clickhouse_client", lambda: mock_client)
        return discovery_mod.TraceDiscoveryService()

    def test_returns_keys_with_counts_in_frequency_order(self, monkeypatch):
        mock_client = MagicMock()
        mock_client.query.return_value.result_rows = [("tenant_id", 120), ("release", 8)]
        svc = self._service(monkeypatch, mock_client)

        out = svc.get_distinct_metadata_keys(project_id="p1")

        assert out == [
            {"value": "tenant_id", "count": 120},
            {"value": "release", "count": 8},
        ]
        assert "ORDER BY n DESC" in mock_client.query.call_args[0][0]

    def test_enumerates_map_keys_from_project_scoped_spans_and_traces(self, monkeypatch):
        """Both key spaces or neither: a trace-level key can never reach a span, so a
        spans-only scan would offer the column picker nothing to pick."""
        mock_client = MagicMock()
        mock_client.query.return_value.result_rows = []
        svc = self._service(monkeypatch, mock_client)

        svc.get_distinct_metadata_keys(project_id="p1")

        sql, kwargs = mock_client.query.call_args
        query_text = sql[0]
        assert query_text.count("arrayJoin(mapKeys(metadata_map))") == 2
        assert "FROM spans" in query_text
        assert "FROM traces" in query_text
        assert query_text.count("project_id = {project_id:String}") == 2
        assert "GROUP BY value" in query_text
        assert kwargs["parameters"]["project_id"] == "p1"

    def test_counts_are_summed_per_key_across_both_tables(self, monkeypatch):
        """One GROUP BY over the union, not one per half: a key carried by both a trace
        row and its spans is one suggestion whose count is everything carrying it."""
        mock_client = MagicMock()
        mock_client.query.return_value.result_rows = [("tenant_id", 9)]
        svc = self._service(monkeypatch, mock_client)

        out = svc.get_distinct_metadata_keys(project_id="p1")

        query_text = mock_client.query.call_args[0][0]
        assert "UNION ALL" in query_text
        assert query_text.count("GROUP BY value") == 1
        assert query_text.index("UNION ALL") < query_text.index("GROUP BY value")
        assert out == [{"value": "tenant_id", "count": 9}]

    def test_frequency_order_and_the_cap_apply_to_the_unioned_result(self, monkeypatch):
        """Capping each half first would let a key that is frequent overall fall off both
        lists while a key frequent in only one survives."""
        from rest.services.trace_discovery import DISCOVERY_LIMIT

        mock_client = MagicMock()
        mock_client.query.return_value.result_rows = []
        svc = self._service(monkeypatch, mock_client)

        svc.get_distinct_metadata_keys(project_id="p1")

        query_text = mock_client.query.call_args[0][0]
        assert query_text.count("ORDER BY n DESC") == 1
        assert query_text.count(f"LIMIT {DISCOVERY_LIMIT}") == 1
        assert query_text.index("UNION ALL") < query_text.index("ORDER BY n DESC")
        assert query_text.index("UNION ALL") < query_text.index(f"LIMIT {DISCOVERY_LIMIT}")

    def test_dedups_each_table_before_the_key_fanout(self, monkeypatch):
        """LIMIT 1 BY is applied after the SELECT expressions are evaluated, so the
        arrayJoin has to sit in a layer ABOVE the dedup — otherwise every row would
        contribute exactly one of its keys and multi-key rows would lose the rest. Each
        half dedups on its own table's logical row identity."""
        mock_client = MagicMock()
        mock_client.query.return_value.result_rows = []
        svc = self._service(monkeypatch, mock_client)

        svc.get_distinct_metadata_keys(project_id="p1")

        lines = [line.strip() for line in mock_client.query.call_args[0][0].splitlines()]
        fanouts = [
            i for i, line in enumerate(lines) if line.startswith("SELECT arrayJoin(mapKeys(")
        ]
        dedups = [i for i, line in enumerate(lines) if line.startswith("LIMIT 1 BY")]

        assert {lines[i] for i in dedups} == {
            "LIMIT 1 BY project_id, trace_id, span_id",  # a span is one logical row
            "LIMIT 1 BY project_id, trace_id",  # so is a trace
        }
        assert len(fanouts) == len(dedups) == 2
        assert all(fanout < dedup for fanout, dedup in zip(fanouts, dedups))

    def test_window_bounds_both_halves_at_both_ends(self, monkeypatch):
        """A discovery scan stands alone — no trace-level semi-join above it re-filters
        what it admits — so neither half may offer keys from outside the active window."""
        mock_client = MagicMock()
        mock_client.query.return_value.result_rows = []
        svc = self._service(monkeypatch, mock_client)

        svc.get_distinct_metadata_keys(
            project_id="p1",
            start_after=datetime(2026, 6, 1),
            end_before=datetime(2026, 6, 2),
        )

        sql, kwargs = mock_client.query.call_args
        assert "span_start_time >= {start_after:DateTime64(3)}" in sql[0]
        assert "span_start_time < {end_before:DateTime64(3)}" in sql[0]
        assert "trace_start_time >= {start_after:DateTime64(3)}" in sql[0]
        assert "trace_start_time < {end_before:DateTime64(3)}" in sql[0]
        assert kwargs["parameters"]["start_after"] == datetime(2026, 6, 1)
        assert kwargs["parameters"]["end_before"] == datetime(2026, 6, 2)

    def test_detector_self_traces_are_excluded_from_both_halves(self, monkeypatch):
        """A suggestion list is customer-facing, and internal telemetry carries keys the
        customer never set and cannot act on."""
        from rest.services.trace_reader import customer_traffic_only

        mock_client = MagicMock()
        mock_client.query.return_value.result_rows = []
        svc = self._service(monkeypatch, mock_client)

        svc.get_distinct_metadata_keys(project_id="p1")

        assert mock_client.query.call_args[0][0].count(customer_traffic_only()) == 2

    def test_no_window_defaults_a_lookback_bound_on_both_halves(self, monkeypatch):
        from rest.services.trace_reader import DEFAULT_SPAN_SCAN_LOOKBACK_HOURS

        mock_client = MagicMock()
        mock_client.query.return_value.result_rows = []
        svc = self._service(monkeypatch, mock_client)

        before = datetime.now(UTC).replace(tzinfo=None)
        svc.get_distinct_metadata_keys(project_id="p1")
        after = datetime.now(UTC).replace(tzinfo=None)

        sql, kwargs = mock_client.query.call_args
        assert "span_start_time >= {start_after:DateTime64(3)}" in sql[0]
        assert "trace_start_time >= {start_after:DateTime64(3)}" in sql[0]
        lookback = timedelta(hours=DEFAULT_SPAN_SCAN_LOOKBACK_HOURS)
        assert before - lookback <= kwargs["parameters"]["start_after"] <= after - lookback
        # One binding serves both halves, so they cannot drift onto different windows.
        assert "start_after" in kwargs["parameters"]

    def test_end_before_only_defaults_start_relative_to_it(self, monkeypatch):
        from rest.services.trace_reader import DEFAULT_SPAN_SCAN_LOOKBACK_HOURS

        mock_client = MagicMock()
        mock_client.query.return_value.result_rows = []
        svc = self._service(monkeypatch, mock_client)

        end = datetime(2026, 6, 2, 12, 0, 0)
        svc.get_distinct_metadata_keys(project_id="p1", end_before=end)

        params = mock_client.query.call_args.kwargs["parameters"]
        assert params["start_after"] == end - timedelta(hours=DEFAULT_SPAN_SCAN_LOOKBACK_HOURS)

    def test_query_excludes_empty_keys_and_respects_the_cap(self, monkeypatch):
        from rest.services.trace_discovery import DISCOVERY_LIMIT

        mock_client = MagicMock()
        mock_client.query.return_value.result_rows = []
        svc = self._service(monkeypatch, mock_client)

        svc.get_distinct_metadata_keys(project_id="p1")

        query_text = mock_client.query.call_args[0][0]
        assert "value != ''" in query_text  # blanks aren't offered as suggestions
        assert f"LIMIT {DISCOVERY_LIMIT}" in query_text

    def test_results_are_cached_per_project_and_window(self, monkeypatch):
        mock_client = MagicMock()
        mock_client.query.return_value.result_rows = [("tenant_id", 3)]
        svc = self._service(monkeypatch, mock_client)

        first = svc.get_distinct_metadata_keys(project_id="p1")
        second = svc.get_distinct_metadata_keys(project_id="p1")

        assert first == second
        mock_client.query.assert_called_once()  # second call served from cache

    @pytest.mark.parametrize(
        "second_time,expected_calls",
        [((0, 0, 45), 1), ((0, 1, 5), 2)],
        ids=["same-minute-reuses-the-cache", "a-new-minute-is-a-fresh-answer"],
    )
    def test_the_cache_key_is_floored_to_the_whole_minute(
        self, monkeypatch, second_time, expected_calls
    ):
        """Sub-minute jitter (the UI recomputes "now - duration" every render) must not force
        a fresh full-project GROUP BY, while a genuinely new minute must."""
        mock_client = MagicMock()
        mock_client.query.return_value.result_rows = [("tenant_id", 3)]
        svc = self._service(monkeypatch, mock_client)

        svc.get_distinct_metadata_keys(project_id="p1", start_after=datetime(2026, 6, 1, 0, 0, 5))
        svc.get_distinct_metadata_keys(
            project_id="p1", start_after=datetime(2026, 6, 1, *second_time)
        )

        assert mock_client.query.call_count == expected_calls

    def test_key_discovery_does_not_share_a_cache_entry_with_a_column(self, monkeypatch):
        """Both answers live in one cache; a collision would serve model names as keys."""
        mock_client = MagicMock()
        mock_client.query.return_value.result_rows = [("gpt-4", 3)]
        svc = self._service(monkeypatch, mock_client)
        window = {"start_after": datetime(2026, 6, 1), "end_before": datetime(2026, 6, 2)}

        svc.get_distinct_span_values(project_id="p1", column="model_name", **window)
        svc.get_distinct_metadata_keys(project_id="p1", **window)

        assert mock_client.query.call_count == 2
        assert "arrayJoin(mapKeys(metadata_map))" in mock_client.query.call_args[0][0]


class TestDiscoveryWindowRuleIsShared:
    """Every discovery surface answers over the same window, because there is one window
    rule rather than one per surface. A dropdown that defaulted a different lookback from
    the key combobox beside it would offer options over a range the user never chose, and
    the drift would be invisible until someone compared two suggestion lists."""

    def _service(self, monkeypatch, mock_client):
        import rest.services.trace_discovery as discovery_mod

        monkeypatch.setattr(discovery_mod, "get_clickhouse_client", lambda: mock_client)
        return discovery_mod.TraceDiscoveryService()

    def _bound_window(self, mock_client) -> dict:
        """The window parameters the last query actually bound."""
        params = mock_client.query.call_args.kwargs["parameters"]
        return {k: v for k, v in params.items() if k in ("start_after", "end_before")}

    def test_a_value_dropdown_and_key_discovery_default_the_same_lower_bound(self, monkeypatch):
        """An absent lower bound is defaulted, never left open, and defaulted identically:
        both anchor the same lookback to the window's end."""
        mock_client = MagicMock()
        mock_client.query.return_value.result_rows = []
        svc = self._service(monkeypatch, mock_client)
        end = datetime(2026, 6, 2, 12, 0, 0)

        svc.get_distinct_span_values(project_id="p1", column="model_name", end_before=end)
        dropdown_window = self._bound_window(mock_client)
        svc.get_distinct_metadata_keys(project_id="p1", end_before=end)
        keys_window = self._bound_window(mock_client)

        assert dropdown_window == keys_window
        assert dropdown_window["start_after"] < end  # defaulted, not left open


class TestGetTraceDiscoveryService:
    """The accessor hands out one service, so the answer cache it holds is shared."""

    def test_repeated_calls_return_the_same_instance(self, monkeypatch):
        import rest.services.trace_discovery as discovery_mod

        monkeypatch.setattr(discovery_mod, "get_clickhouse_client", lambda: MagicMock())
        monkeypatch.setattr(discovery_mod, "_service", None)

        assert discovery_mod.get_trace_discovery_service() is (
            discovery_mod.get_trace_discovery_service()
        )
