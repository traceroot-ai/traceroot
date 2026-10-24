"""Shared reverse-proxy plumbing for public routes served by the Next.js control plane.

Some public resources (API keys, datasets, evaluation runs) are owned by the
Next.js app because that is where their storage and authorization live, but SDK
and CLI clients only ever learn one ``host_url``. So this service authenticates
the request and forwards it, and the control plane re-validates the same Bearer
key authoritatively — no token exchange, no second host to configure.

This module is deliberately resource-agnostic, so a router that needs the same
proxying does not copy ~100 lines of it. Anything added here must stay free of
resource-specific behaviour.

A proxy that concatenates caller-controlled path text onto an internal origin is
an open reverse proxy, so no caller-supplied segment may be interpolated into
``subpath`` raw: ``path_segment`` below is what a router runs it through first.
"""

import logging
import re

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

# One path segment of a forwarded URL: an opaque id, deliberately narrow. No
# `/`, `%`, `\`, `:` or whitespace can pass, so percent-encoded traversal
# (`..%2F`, which the ASGI server has already unquoted by the time the route
# matches), double-encoded traversal (`%252e`, which arrives with a literal `%`),
# backslash traversal and absolute URLs (`http://…`) are all refused before any
# URL is built. The eval gateway's `_SEGMENT_RE` is the same class for the same
# reason.
_PATH_SEGMENT_RE = re.compile(r"[A-Za-z0-9_.~-]{1,128}")

# Dot-segments match the character class above, so they are excluded by name.
# Percent-encoding them instead would not do it: `quote("..", safe="")` returns
# `..` unchanged, because `.` is one of the characters `quote` never escapes.
_DOT_SEGMENTS = frozenset({".", ".."})


def path_segment(value: str) -> str:
    """Validate one caller-supplied path segment before it is forwarded.

    ``forward`` concatenates its ``subpath`` onto the control-plane origin and
    httpx then resolves the result, which does two things a router does not
    intend. A segment of ``..`` is resolved away, so ``api-keys/..`` leaves this
    process as ``DELETE /api/public`` — a different upstream handler from the one
    the route names; and a segment carrying ``?`` or ``#`` re-points the
    forwarded URL's query or truncates its path. The control plane
    re-authenticates, so neither is privilege escalation, but a request reaching
    a handler other than the intended one is not a thing to allow on the way to
    finding that out.

    Args:
        value (str): The caller-supplied segment, such as a key id.

    Returns:
        str: ``value`` unchanged, once it is known to be one opaque segment.

    Raises:
        HTTPException: 404 if it is not. A 404 rather than a 400 keeps the
            gateway from confirming which internal paths exist, matching the
            eval gateway's answer to the same input.
    """
    if value in _DOT_SEGMENTS or not _PATH_SEGMENT_RE.fullmatch(value):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Not found")
    return value


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
