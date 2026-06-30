"""Unit tests for gzip compression of REST responses (issue #1041).

Guards that GZipMiddleware stays wired so large JSON responses (e.g. trace
detail, which can be tens of MB) are compressed on the wire.

NOTE: SSE/streaming responses (text/event-stream, e.g. the /live endpoint) are
intentionally NOT covered here. Starlette's GZipMiddleware leaves streaming
responses uncompressed and real-time, but that is timing-dependent behavior
that TestClient cannot observe (it buffers the whole response). It is verified
by an out-of-band streaming repro instead. See issue #1041 / the design doc.
"""

from fastapi.testclient import TestClient

from rest.main import app


def test_gzip_middleware_is_registered():
    """Defensive regression guard: the middleware must not be silently removed."""
    assert any(m.cls.__name__ == "GZipMiddleware" for m in app.user_middleware), (
        "GZipMiddleware is not registered on the REST app"
    )


def test_large_json_response_is_gzipped():
    """A response over minimum_size is gzip-encoded when the client accepts it."""
    client = TestClient(app)
    # /openapi.json is unauthenticated and comfortably exceeds the 1024-byte
    # minimum_size threshold.
    resp = client.get("/openapi.json", headers={"Accept-Encoding": "gzip"})
    assert resp.status_code == 200
    assert resp.headers.get("content-encoding") == "gzip"
    # Body still decodes correctly after compression.
    assert resp.json()["info"]["title"]


def test_response_not_gzipped_when_client_declines():
    """No content-encoding when the client does not accept gzip."""
    client = TestClient(app)
    resp = client.get("/openapi.json", headers={"Accept-Encoding": "identity"})
    assert resp.status_code == 200
    assert resp.headers.get("content-encoding") != "gzip"
