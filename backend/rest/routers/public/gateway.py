"""Shared reverse-proxy plumbing for public routes served by the Next.js control plane.

Some public resources (API keys, datasets, evaluation runs) are owned by the
Next.js app because that is where their storage and authorization live, but SDK
and CLI clients only ever learn one ``host_url``. So this service authenticates
the request and forwards it, and the control plane re-validates the same Bearer
key authoritatively — no token exchange, no second host to configure.

This module is deliberately resource-agnostic, so a router that needs the same
proxying does not copy ~100 lines of it. Anything added here must stay free of
resource-specific behaviour.
"""

import logging

import httpx
from fastapi import HTTPException, Request, Response, status
from fastapi.responses import JSONResponse

from shared.config import settings

logger = logging.getLogger(__name__)

# Hop-by-hop and host-specific headers must not be forwarded: `host` would
# address the wrong service and `content-length` would contradict the re-encoded
# body. `accept-encoding` is dropped so httpx hands us a decoded body to inspect.
_SKIP_REQUEST_HEADERS = {"host", "content-length", "connection", "accept-encoding"}

_GENERIC_UPSTREAM_ERROR = "Request failed"


def normalized_error(
    upstream: httpx.Response, generic: str = _GENERIC_UPSTREAM_ERROR
) -> JSONResponse:
    """Re-serialize an upstream non-2xx into the canonical ``{"detail": ...}`` shape.

    The control plane answers with ``{"detail": ...}`` on public routes but
    ``{"error": ...}`` on older ones, while the public API contract is uniformly
    ``{"detail": ...}``. Only a safe human-readable *string* is surfaced — never
    the raw upstream body, which may be an HTML error page or a stack trace —
    falling back to ``generic`` otherwise. The upstream status is preserved so
    clients can still distinguish 401 from 404 from 409.
    """
    detail = generic
    try:
        data = upstream.json()
    except ValueError:
        data = None
    if isinstance(data, dict):
        message = data.get("detail")
        if not (isinstance(message, str) and message.strip()):
            message = data.get("error")
        if isinstance(message, str) and message.strip():
            detail = message.strip()
    return JSONResponse(status_code=upstream.status_code, content={"detail": detail})


async def forward(
    request: Request,
    subpath: str,
    *,
    unavailable_detail: str = "Service unavailable",
    generic_error: str = _GENERIC_UPSTREAM_ERROR,
) -> Response:
    """Proxy the current request to the control plane's ``/api/public/<subpath>``.

    Successful responses pass through verbatim, including status and content
    type, so a 201 or a 204 survives. Failures are normalized; a transport
    failure is a native 503 in the same shape, because a client cannot act on
    the difference between "the control plane refused" and "the control plane
    was unreachable" unless we say so consistently.

    The caller's Authorization header rides along untouched — that is what lets
    the control plane make the authoritative decision.
    """
    url = f"{settings.traceroot_ui_url.rstrip('/')}/api/public/{subpath}"
    body = await request.body()
    headers = {k: v for k, v in request.headers.items() if k.lower() not in _SKIP_REQUEST_HEADERS}
    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            upstream = await client.request(
                request.method,
                url,
                params=dict(request.query_params),
                content=body,
                headers=headers,
            )
    except httpx.RequestError as e:
        logger.error("Public gateway forward to %s failed: %s", url, e)
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=unavailable_detail,
        ) from e

    if upstream.status_code >= 400:
        return normalized_error(upstream, generic_error)

    # 204 carries no body and no content type; synthesizing one would make a
    # successful revoke look like a malformed response.
    if upstream.status_code == 204 or not upstream.content:
        return Response(status_code=upstream.status_code)

    return Response(
        content=upstream.content,
        status_code=upstream.status_code,
        media_type=upstream.headers.get("content-type", "application/json"),
    )
