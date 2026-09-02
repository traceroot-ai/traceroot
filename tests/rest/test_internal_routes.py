"""Guards for the internal route table.

The internal router is assembled from one module per surface. A sub-router
that silently stops being included, or a route that loses its secret check,
passes every test except the ones that hit that exact endpoint — and not every
endpoint has one. Pin the whole table here instead.
"""

from fastapi.routing import APIRoute
from fastapi.testclient import TestClient

from rest.main import app
from rest.routers.internal.auth import verify_internal_secret
from shared.config import settings

INTERNAL_PREFIX = "/api/v1/internal/"

EXPECTED_ROUTES = {
    ("GET", "/api/v1/internal/usage/total"),
    ("GET", "/api/v1/internal/usage/details"),
    ("POST", "/api/v1/internal/detector-runs"),
    ("POST", "/api/v1/internal/detector-findings"),
    ("GET", "/api/v1/internal/detector-runs"),
    ("GET", "/api/v1/internal/traces/{trace_id}/spans-jsonl"),
    ("GET", "/api/v1/internal/traces/{trace_id}/time-since-last-span"),
    ("GET", "/api/v1/internal/traces/{trace_id}/findings"),
    ("GET", "/api/v1/internal/traces/{trace_id}/detector-runs"),
    ("GET", "/api/v1/internal/detector-window-summary"),
    ("POST", "/api/v1/internal/traces"),
}


def _internal_routes() -> list[APIRoute]:
    return [r for r in app.routes if isinstance(r, APIRoute) and r.path.startswith(INTERNAL_PREFIX)]


def test_internal_route_table_is_exactly_the_expected_set():
    actual = {(method, route.path) for route in _internal_routes() for method in route.methods}
    assert actual == EXPECTED_ROUTES


def test_every_internal_route_requires_the_internal_secret():
    for route in _internal_routes():
        dependencies = [d.dependency for d in route.dependencies]
        assert verify_internal_secret in dependencies, f"{sorted(route.methods)} {route.path}"


def test_unset_server_secret_fails_closed_with_503(monkeypatch):
    """No configured secret must reject every caller, not let every caller through."""
    monkeypatch.setattr(settings, "internal_api_secret", "")
    resp = TestClient(app).get(
        "/api/v1/internal/detector-runs",
        params={"project_id": "p1", "detector_id": "d1"},
        headers={"X-Internal-Secret": "anything"},
    )
    assert resp.status_code == 503
