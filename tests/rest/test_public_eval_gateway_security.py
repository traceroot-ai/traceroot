"""Security tests for the public offline-eval gateway (a reverse proxy).

The gateway concatenates a caller-influenced subpath onto the control-plane
origin and relays headers across the trust boundary, so the properties under
test here are the ones that keep it from becoming an open proxy:

* only the nine real upstream routes are reachable, and nothing containing a
  dot-segment (raw or percent-encoded) is ever forwarded;
* forwarded headers are an allowlist — the caller's session `Cookie` and its
  `X-Forwarded-For` never reach the control plane;
* every route is rate limited and stamps the limiter identity;
* the gateway's own validation errors use the documented `{"detail": "<str>"}`
  envelope, and a field the gateway does not model still reaches the handler.

Every test asserts on the *forwarded upstream request* (or on its absence), not
just on the status code, so a regression that forwards the wrong thing fails.
"""

import json

import pytest
import respx
from fastapi import Request
from fastapi.exceptions import RequestValidationError
from fastapi.testclient import TestClient
from httpx import Response

import rest.routers.public.eval as eval_gateway
from rest.main import app, validation_exception_handler
from rest.rate_limit import limiter
from rest.routers.public.deps import (
    AuthResult,
    authenticate_and_stamp_identity,
    authenticate_api_key,
)

UI = "http://localhost:3000"
AUTH_HEADER = {"Authorization": "Bearer tr_sometoken"}

VALID_RUN = {
    "evaluation_name": "e",
    "dataset_id": "d",
    "candidate_version": "v1",
}


@pytest.fixture()
def client():
    app.dependency_overrides[authenticate_api_key] = lambda: AuthResult(
        project_id="proj-A",
        workspace_id="ws-1",
        billing_plan="enterprise",
        ingestion_blocked=False,
    )
    yield TestClient(app)


@pytest.fixture()
def upstream():
    """Catch-all mock for the control plane; `.calls` proves what was forwarded."""
    with respx.mock(assert_all_called=False) as mock:
        mock.route().mock(return_value=Response(200, json={"ok": True}))
        yield mock


# --- Path traversal / route allowlist ---------------------------------------


class TestUpstreamPathAllowlist:
    @pytest.mark.parametrize(
        ("method", "path", "body"),
        [
            # Percent-encoded traversal: uvicorn (and TestClient) unquote the path
            # before routing, so `..%2F` reaches the handler as `../`, and httpx
            # would then collapse it against the control-plane origin.
            ("POST", "/api/v1/public/datasets/..%2F..%2Finternal%2Fvalidate-api-key", {}),
            ("GET", "/api/v1/public/dataset-versions/..%2F..%2Fauth%2Fsign-up%2Femail", None),
            # Single-level traversal through a typed route's `{run_id}`: a valid
            # body, so the request reaches the handler and only the path is at issue.
            ("POST", "/api/v1/public/evaluation-runs/%2e%2e/complete", {"status": "completed"}),
            # Double-encoded traversal arrives with a literal `%`.
            ("POST", "/api/v1/public/datasets/%252e%252e%252finternal", {}),
            # Backslash and absolute-URL smuggling.
            ("POST", "/api/v1/public/datasets/..%5C..%5Cinternal", {}),
            ("POST", "/api/v1/public/datasets/http:%2F%2Fevil.example%2Fx", {}),
        ],
    )
    def test_traversal_attempts_are_404_and_never_forwarded(
        self, client, upstream, method, path, body
    ):
        resp = client.request(method, path, headers=AUTH_HEADER, json=body)
        assert resp.status_code == 404, resp.text
        assert resp.json() == {"detail": "Not found"}
        # The security property: nothing left the process.
        assert upstream.calls.call_count == 0

    @pytest.mark.parametrize(
        "path",
        [
            # Shapes that are not real upstream routes.
            "/api/v1/public/datasets/ds1/versions/v1/extra",
            "/api/v1/public/evaluation-runs/run1/results/tc1/unknown",
            "/api/v1/public/evaluation-runs/run1/anything",
        ],
    )
    def test_unknown_route_shapes_are_404_and_never_forwarded(self, client, upstream, path):
        resp = client.post(path, headers=AUTH_HEADER, json={})
        assert resp.status_code == 404
        assert upstream.calls.call_count == 0

    def test_method_not_implemented_upstream_is_not_forwarded(self, client, upstream):
        # `datasets/{id}/versions` is GET+POST upstream; PATCH is not a real route.
        resp = client.patch("/api/v1/public/datasets/ds1/versions", headers=AUTH_HEADER, json={})
        assert resp.status_code == 404
        assert upstream.calls.call_count == 0

    @pytest.mark.parametrize(
        ("method", "path", "expected_upstream"),
        [
            ("GET", "/api/v1/public/datasets", f"{UI}/api/public/datasets"),
            ("GET", "/api/v1/public/datasets/ds1", f"{UI}/api/public/datasets/ds1"),
            (
                "GET",
                "/api/v1/public/datasets/ds1/versions",
                f"{UI}/api/public/datasets/ds1/versions",
            ),
            (
                "GET",
                "/api/v1/public/dataset-versions/dv1",
                f"{UI}/api/public/dataset-versions/dv1",
            ),
            (
                "POST",
                "/api/v1/public/evaluation-runs/run1/results/tc1/scores",
                f"{UI}/api/public/evaluation-runs/run1/results/tc1/scores",
            ),
            (
                "POST",
                "/api/v1/public/evaluation-runs/run1/results/tc1/human-score",
                f"{UI}/api/public/evaluation-runs/run1/results/tc1/human-score",
            ),
        ],
    )
    def test_real_routes_still_forward_unchanged(
        self, client, upstream, method, path, expected_upstream
    ):
        resp = client.request(method, path, headers=AUTH_HEADER)
        assert resp.status_code == 200
        assert upstream.calls.call_count == 1
        assert str(upstream.calls.last.request.url) == expected_upstream

    def test_typed_route_forwards_its_run_id(self, client, upstream):
        resp = client.post(
            "/api/v1/public/evaluation-runs/run1/complete",
            headers=AUTH_HEADER,
            json={"status": "completed"},
        )
        assert resp.status_code == 200
        assert (
            str(upstream.calls.last.request.url) == f"{UI}/api/public/evaluation-runs/run1/complete"
        )


# --- Header allowlist --------------------------------------------------------


class TestForwardedHeaderAllowlist:
    def test_cookie_and_spoofable_headers_are_stripped(self, client, upstream):
        resp = client.get(
            "/api/v1/public/datasets",
            headers={
                **AUTH_HEADER,
                "Cookie": "better-auth.session_token=stolen",
                "X-Forwarded-For": "1.2.3.4",
                "X-Real-Ip": "1.2.3.4",
                "X-Internal-Secret": "guessed",
                "Te": "trailers",
                "User-Agent": "traceroot-sdk/1.0",
            },
        )
        assert resp.status_code == 200
        forwarded = upstream.calls.last.request.headers
        # The confused-deputy credential must not cross the trust boundary.
        assert "cookie" not in forwarded
        for name in ("x-forwarded-for", "x-real-ip", "x-internal-secret", "te"):
            assert name not in forwarded, name
        # What the SDK legitimately needs still arrives.
        assert forwarded["authorization"] == "Bearer tr_sometoken"
        assert forwarded["user-agent"] == "traceroot-sdk/1.0"

    def test_allowlisted_tracing_headers_are_forwarded(self, client, upstream):
        traceparent = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"
        client.get(
            "/api/v1/public/datasets",
            headers={**AUTH_HEADER, "traceparent": traceparent, "Idempotency-Key": "k1"},
        )
        forwarded = upstream.calls.last.request.headers
        assert forwarded["traceparent"] == traceparent
        assert forwarded["idempotency-key"] == "k1"


# --- Rate limiting -----------------------------------------------------------


def _eval_routes():
    return [
        r
        for r in app.routes
        if getattr(r, "endpoint", None) is not None
        and getattr(r.endpoint, "__module__", "") == eval_gateway.__name__
    ]


class TestRateLimiting:
    def test_every_eval_route_is_registered_with_the_limiter(self):
        routes = _eval_routes()
        assert routes, "no eval gateway routes found"
        registered = set(limiter._dynamic_route_limits)
        for route in routes:
            name = f"{eval_gateway.__name__}.{route.endpoint.__name__}"
            assert name in registered, f"{name} has no rate limit"

    def test_every_eval_route_stamps_the_rate_limit_identity(self):
        """Without the stamped dependency the limiter keys off an unstamped
        request.state, so the decorator above would be inert."""
        for route in _eval_routes():
            calls = [d.call for d in route.dependant.dependencies]
            assert authenticate_and_stamp_identity in calls, route.path


# --- Body cap ----------------------------------------------------------------


def test_oversized_body_is_rejected_before_forwarding(client, upstream, monkeypatch):
    monkeypatch.setattr(eval_gateway, "_MAX_FORWARD_BODY_BYTES", 16)
    resp = client.post(
        "/api/v1/public/evaluation-runs/run1/results/tc1/scores",
        headers=AUTH_HEADER,
        content=b"x" * 64,
    )
    assert resp.status_code == 413
    assert resp.json() == {"detail": "Request body too large"}
    assert upstream.calls.call_count == 0


# --- Error envelope ----------------------------------------------------------


class TestErrorEnvelope:
    def test_gateway_validation_error_uses_the_detail_string_envelope(self, client, upstream):
        resp = client.post(
            "/api/v1/public/evaluation-runs",
            headers=AUTH_HEADER,
            json={**VALID_RUN, "case_count": -1},
        )
        assert resp.status_code == 422
        body = resp.json()
        # Not FastAPI's default list-of-objects: an SDK formats this as a message.
        assert isinstance(body["detail"], str)
        assert "case_count" in body["detail"]
        assert upstream.calls.call_count == 0

    def test_upstream_error_reads_the_same_shape(self, client):
        with respx.mock(assert_all_called=False) as mock:
            mock.route().mock(return_value=Response(400, json={"error": "bad dataset"}))
            resp = client.post(
                "/api/v1/public/evaluation-runs", headers=AUTH_HEADER, json=VALID_RUN
            )
        assert resp.status_code == 400
        assert resp.json() == {"detail": "bad dataset"}

    async def test_non_public_routes_keep_fastapis_default_envelope(self):
        """The string envelope is the *public* contract; the dashboard/internal
        routes keep FastAPI's default body, which the Next.js app already parses."""
        errors = [{"loc": ("query", "limit"), "msg": "Input should be <= 200", "type": "le"}]
        request = Request(
            {"type": "http", "method": "GET", "path": "/api/v1/traces", "headers": []}
        )
        resp = await validation_exception_handler(request, RequestValidationError(errors))
        assert isinstance(json.loads(resp.body)["detail"], list)


# --- Verbatim body forwarding ------------------------------------------------


def test_unmodelled_field_still_reaches_the_handler(client, upstream):
    """The gateway must not be the strictness gate — a
    field a newer SDK adds has to reach the Prisma-owned handler that owns it."""
    resp = client.post(
        "/api/v1/public/evaluation-runs",
        headers=AUTH_HEADER,
        json={**VALID_RUN, "field_from_a_newer_sdk": "keep-me"},
    )
    assert resp.status_code == 200
    assert upstream.calls.call_count == 1
    assert b"field_from_a_newer_sdk" in upstream.calls.last.request.content


# --- Retention surface ---------------------------------------------------------


class TestNoUngatedRetentionRead:
    """The gateway exposes no time-windowed read of evaluation runs, so it has
    nothing to apply ``rest.retention.clamp_retention_window`` to.

    Evaluation-run *reads* are served by the Prisma-owned Next.js route
    (``frontend/ui/src/app/api/projects/[projectId]/evaluations/runs/route.ts``),
    which is where the plan clamp lives. What is asserted here is the premise that
    makes that sufficient: this gateway's ``evaluation-runs`` surface is
    write-only. Adding a listing GET without a retention clamp would reopen the
    entitlement leak on a path the Next route never sees, so it fails here first.
    """

    def test_evaluation_runs_allowlist_is_write_only(self):
        for shape, methods in eval_gateway._UPSTREAM_ROUTES:
            if shape[0] != "evaluation-runs":
                continue
            assert methods <= {"POST"}, (
                f"{'/'.join(shape)} now allows {sorted(methods - {'POST'})}. A read of "
                "evaluation runs must clamp the window to the caller's plan "
                "(rest.retention.clamp_retention_window) before it is allowlisted."
            )

    @pytest.mark.parametrize(
        "path",
        [
            "/api/v1/public/evaluation-runs",
            "/api/v1/public/evaluation-runs?started_after=2020-01-01T00:00:00Z",
            "/api/v1/public/evaluation-runs/run1",
        ],
    )
    def test_reading_runs_through_the_gateway_is_refused(self, client, upstream, path):
        resp = client.get(path, headers=AUTH_HEADER)
        # 405 today (every `evaluation-runs` route is POST-only, so the read is
        # refused at routing); 404 if the shape itself stops existing. Either way
        # the request never reaches the control plane.
        assert resp.status_code in (404, 405), resp.text
        assert upstream.calls.call_count == 0
