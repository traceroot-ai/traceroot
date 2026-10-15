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

# Only what a client actually needs crosses the trust boundary. An allowlist (not
# a denylist) so a header nobody thought about cannot be relayed: `cookie` would
# hand the control plane a second, session-scoped credential on a Bearer-authed
# request (confused deputy); `transfer-encoding` would contradict the
# `Content-Length` httpx derives from the buffered body (request-smuggling shape);
# `x-forwarded-for`/`x-real-ip` are caller-chosen and would poison upstream logs.
# `host` would address the wrong service and `accept-encoding` is omitted so httpx
# hands us a decoded body to inspect.
_FORWARD_REQUEST_HEADERS = frozenset(
    {
        "authorization",
        "content-type",
        "accept",
        "user-agent",
        "traceparent",
        "tracestate",
        "idempotency-key",
    }
)

# `forward` buffers the body into REST-process memory before sending it upstream,
# so it needs a ceiling. Nothing in front of this process imposes one, and the
# largest legitimate body on these routes is a small JSON object.
_MAX_FORWARD_BODY_BYTES = 8 * 1024 * 1024

_GENERIC_UPSTREAM_ERROR = "Request failed"


async def _read_capped_body(request: Request) -> bytes:
    """Buffer the request body, refusing anything over ``_MAX_FORWARD_BODY_BYTES``.

    A declared ``Content-Length`` is rejected up front so an oversized upload is
    refused before it is read; the streaming check below is what actually enforces
    the cap (a chunked or mis-declared body has no trustworthy length).

    Raises:
        HTTPException: 413 if the body exceeds the cap.
    """
    declared = request.headers.get("content-length")
    if declared is not None and declared.isdigit() and int(declared) > _MAX_FORWARD_BODY_BYTES:
        raise HTTPException(
            status_code=status.HTTP_413_CONTENT_TOO_LARGE,
            detail="Request body too large",
        )
    chunks: list[bytes] = []
    total = 0
    async for chunk in request.stream():
        total += len(chunk)
        if total > _MAX_FORWARD_BODY_BYTES:
            raise HTTPException(
                status_code=status.HTTP_413_CONTENT_TOO_LARGE,
                detail="Request body too large",
            )
        chunks.append(chunk)
    return b"".join(chunks)


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
    body = await _read_capped_body(request)
    headers = {k: v for k, v in request.headers.items() if k.lower() in _FORWARD_REQUEST_HEADERS}
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
