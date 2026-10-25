"""Security headers on REST API responses.

Browsers reach /api/v1 on the same host as the web app, and the application
security scan of staging reported these responses without HSTS or nosniff.
"""

from fastapi.testclient import TestClient
from starlette.applications import Starlette
from starlette.responses import JSONResponse, StreamingResponse
from starlette.routing import Route

from rest.main import app
from rest.security_headers import SECURITY_HEADERS, SecurityHeadersMiddleware


def _assert_secured(resp) -> None:
    assert resp.headers.get("strict-transport-security") == "max-age=63072000"
    assert resp.headers.get("x-content-type-options") == "nosniff"


def test_middleware_wraps_every_other_middleware():
    """Outermost, so responses other middleware answer on their own get the headers too."""
    assert app.user_middleware[0].cls is SecurityHeadersMiddleware


def test_success_and_error_responses_carry_the_headers():
    client = TestClient(app)
    for path, status in [
        ("/health", 200),
        ("/api/v1/projects/p1/traces/exists", 401),
        ("/api/v1/no-such-route", 404),
    ]:
        resp = client.get(path)
        assert resp.status_code == status, path
        _assert_secured(resp)


def test_a_response_the_sql_body_limit_answers_carries_the_headers():
    """The 413 comes from SqlBodyLimitMiddleware before any route runs."""
    from rest.routers.public.sql import SQL_REQUEST_MAX_BYTES

    resp = TestClient(app).post(
        "/api/v1/public/sql",
        content=b"x" * (SQL_REQUEST_MAX_BYTES + 1),
        headers={"content-type": "application/json"},
    )
    assert resp.status_code == 413
    _assert_secured(resp)


def _app_with(endpoint) -> TestClient:
    inner = Starlette(routes=[Route("/", endpoint)])
    return TestClient(SecurityHeadersMiddleware(inner))


def test_a_streamed_response_keeps_its_body():
    async def chunks():
        yield b"data: one\n\n"
        yield b"data: two\n\n"

    async def stream(_request):
        return StreamingResponse(chunks(), media_type="text/event-stream")

    resp = _app_with(stream).get("/")
    assert resp.text == "data: one\n\ndata: two\n\n"
    _assert_secured(resp)


def test_a_value_the_route_sets_is_kept():
    async def preload(_request):
        return JSONResponse(
            {}, headers={"Strict-Transport-Security": "max-age=63072000; includeSubDomains"}
        )

    resp = _app_with(preload).get("/")
    assert resp.headers["strict-transport-security"] == "max-age=63072000; includeSubDomains"
    assert resp.headers["x-content-type-options"] == SECURITY_HEADERS["X-Content-Type-Options"]
