"""Public offline-evaluation API gateway.

Datasets, dataset versions, and evaluation runs live in the Postgres control
plane, which is owned by the Next.js app (Prisma). This router is a thin
authenticated reverse proxy: it forwards the SDK's

    /api/v1/public/{datasets,dataset-versions,evaluation-runs}/*

requests to the Next.js ``/api/public/*`` route handlers that implement them, so
the SDK reaches dataset authoring + run reporting through the SAME ``host_url``
it already uses for trace ingestion — no separate eval URL. This is the
"two-hop" production path the SDK contract anticipated: SDK → this gateway →
Next.js control plane.

Auth is enforced here (``KeyStampedAuth``, same as every public route) and the
Bearer key is forwarded so the Next.js handler re-validates authoritatively
against Postgres.

Proxy safety
------------
A proxy that concatenates caller-controlled path text onto an internal origin is
an open reverse proxy, so nothing here is built by concatenation alone:

* every path segment must match ``_SEGMENT_RE`` (no ``/``, ``%``, ``\\``, ``:``
  or dot-segments survive it), and
* the resulting ``(shape, method)`` must be one of the nine real upstream routes
  in ``_UPSTREAM_ROUTES`` — an explicit allowlist mirroring
  ``frontend/ui/src/app/api/public/**/route.ts``.

Anything else is a 404, so the gateway fails closed rather than relying on URL
normalization. Forwarded headers are likewise an allowlist
(``_FORWARD_REQUEST_HEADERS``), not a denylist: the caller's ``Cookie``, its
``X-Forwarded-For``, and hop-by-hop framing headers never reach the control
plane.
"""

import logging
import re
from typing import Any

import httpx
from fastapi import APIRouter, HTTPException, Request, Response, status
from fastapi.responses import JSONResponse

from rest.rate_limit import (
    BUCKET_INGEST,
    BUCKET_READ,
    is_request_rate_limit_exempt,
    key_ingest,
    key_read,
    limiter,
    resolve_limit,
)
from rest.routers.public.deps import KeyStampedAuth
from rest.schemas.eval import (
    CompleteRunRequest,
    CompleteRunResponse,
    ErrorResponse,
    RegisterRunRequest,
    RegisterRunResponse,
    UpsertResultRequest,
    UpsertResultResponse,
)
from shared.config import settings

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/public", tags=["Offline Eval (Public)"])

# One path segment: an opaque cuid/slug. Deliberately narrow — no `/`, `%`, `\`,
# `:` or whitespace can pass, so percent-encoded traversal (`..%2F`, which uvicorn
# has already unquoted to `../` by the time the route matches), double-encoded
# traversal (`%252e`, which arrives with a literal `%`), backslash traversal, and
# absolute URLs (`http://…`) are all rejected before any URL is built.
_SEGMENT_RE = re.compile(r"[A-Za-z0-9_.~-]{1,128}")

# Dot-segments match the character class above, so they are excluded by name.
_DOT_SEGMENTS = frozenset({".", ".."})

# The complete set of upstream routes this gateway may reach, as
# (segment shape, allowed methods). `*` is one opaque id segment. This mirrors
# `frontend/ui/src/app/api/public/**/route.ts` one-for-one; adding a route there
# without adding it here means the gateway 404s it (fail closed, by design).
_UPSTREAM_ROUTES: tuple[tuple[tuple[str, ...], frozenset[str]], ...] = (
    (("datasets",), frozenset({"GET", "POST"})),
    (("datasets", "*"), frozenset({"GET", "PATCH"})),
    (("datasets", "*", "versions"), frozenset({"GET", "POST"})),
    (("dataset-versions", "*"), frozenset({"GET"})),
    (("evaluation-runs",), frozenset({"POST"})),
    (("evaluation-runs", "*", "complete"), frozenset({"POST"})),
    (("evaluation-runs", "*", "results"), frozenset({"POST"})),
    (("evaluation-runs", "*", "results", "*", "human-score"), frozenset({"POST"})),
    (("evaluation-runs", "*", "results", "*", "scores"), frozenset({"POST"})),
)

# Only what the SDK actually needs crosses the trust boundary. An allowlist (not a
# denylist) so a header nobody thought about cannot be relayed: `cookie` would
# hand the control plane a second, session-scoped credential on a Bearer-authed
# request (confused deputy); `transfer-encoding` would contradict the
# `Content-Length` httpx derives from the buffered body (request-smuggling shape);
# `x-forwarded-for`/`x-real-ip` are caller-chosen and would poison upstream logs.
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

# `_forward` buffers the body into REST-process memory before sending it upstream,
# so it needs a ceiling. Sized above the largest legal typed payload (an upsert
# carries four 1 MB text fields plus its scores) with headroom, and far below
# anything that would pressure the process.
_MAX_FORWARD_BODY_BYTES = 8 * 1024 * 1024

# Shown when an upstream failure carries no usable message (non-JSON body, HTML
# error page, unexpected structure). Deliberately generic so nothing internal leaks.
_GENERIC_UPSTREAM_ERROR = "Evaluation request failed"


def _upstream_path(method: str, *parts: str) -> str:
    """Validate caller-supplied path text and return the safe upstream subpath.

    Args:
        method (str): The request method; matched against the route's allowlist
            entry so only the verbs the upstream handler implements forward.
        *parts (str): Path fragments to join, each of which may itself contain
            ``/`` (the ``{subpath:path}`` catch-alls bind a whole tail here).

    Returns:
        str: The validated ``a/b/c`` subpath, safe to concatenate onto the
            control-plane origin.

    Raises:
        HTTPException: 404 if any segment is not a plain opaque token, or if the
            resulting shape+method is not one of the known upstream routes. A 404
            (rather than 400) keeps the gateway from confirming which internal
            paths exist.
    """
    segments = [s for part in parts for s in part.split("/") if s]
    if not segments:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Not found")
    for segment in segments:
        if segment in _DOT_SEGMENTS or not _SEGMENT_RE.fullmatch(segment):
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Not found")
    for shape, methods in _UPSTREAM_ROUTES:
        if len(shape) != len(segments) or method.upper() not in methods:
            continue
        if all(e == "*" or e == a for e, a in zip(shape, segments)):
            return "/".join(segments)
    raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Not found")


def _normalized_error(upstream: httpx.Response) -> JSONResponse:
    """Re-serialize an upstream non-2xx into the canonical ``{"detail": ...}`` shape.

    The Next.js control plane returns ``{"error": ...}`` (and occasionally
    ``{"detail": ...}``); the public API contract is uniformly ``{"detail": ...}``.
    We surface only a safe human-readable *string* message and never the raw
    upstream body — which could be an HTML error page, a stack trace, or unexpected
    structure — falling back to a generic message otherwise. The upstream HTTP
    status is preserved.
    """
    detail = _GENERIC_UPSTREAM_ERROR
    conflict: dict = {}
    try:
        data = upstream.json()
    except ValueError:
        data = None
    if isinstance(data, dict):
        # Prefer an already-canonical `detail`, else accept Next.js's `error`.
        message = data.get("detail")
        if not (isinstance(message, str) and message.strip()):
            message = data.get("error")
        if isinstance(message, str) and message.strip():
            detail = message.strip()
        # Preserve the optimistic-concurrency conflict fields (a version 409) so the SDK
        # can report which base was stale and what the current version is — flattening to
        # detail-only left its conflict diagnostics permanently None. Only these known
        # keys, str-or-null, are passed through — never the raw upstream body.
        for key in ("base_version_id", "current_version_id"):
            if key in data and (data[key] is None or isinstance(data[key], str)):
                conflict[key] = data[key]
    return JSONResponse(status_code=upstream.status_code, content={"detail": detail, **conflict})


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
    # Starlette replays the cached body here when a typed route already parsed it.
    async for chunk in request.stream():
        total += len(chunk)
        if total > _MAX_FORWARD_BODY_BYTES:
            raise HTTPException(
                status_code=status.HTTP_413_CONTENT_TOO_LARGE,
                detail="Request body too large",
            )
        chunks.append(chunk)
    return b"".join(chunks)


async def _forward(request: Request, subpath: str) -> Response:
    """Proxy the current request to the Next.js ``/api/public/<subpath>`` route.

    ``subpath`` MUST already have come from ``_upstream_path`` — this function
    concatenates it onto the control-plane origin verbatim.

    Successful (2xx/3xx) responses pass through verbatim. Upstream failures are
    normalized to ``{"detail": ...}`` (see ``_normalized_error``); a transport
    failure reaching the control plane is a native 503 in the same shape.
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
        logger.error("Eval gateway forward to %s failed: %s", url, e)
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Evaluation service unavailable",
        ) from e

    if upstream.status_code >= 400:
        return _normalized_error(upstream)

    return Response(
        content=upstream.content,
        status_code=upstream.status_code,
        media_type=upstream.headers.get("content-type", "application/json"),
    )


# --- Datasets (A1/A2 list+upsert, A3 patch, A4/A5 versions) -----------------
# Dataset traffic is authoring/read traffic, so it shares the READ bucket; the run
# reporting writes below use INGEST. Every route takes KeyStampedAuth, which is what
# puts the workspace + plan on request.state for the limiter's key_func.
@router.api_route("/datasets", methods=["GET", "POST"], include_in_schema=False)
@limiter.shared_limit(
    resolve_limit, scope=BUCKET_READ, key_func=key_read, exempt_when=is_request_rate_limit_exempt
)
async def datasets_root(request: Request, auth: KeyStampedAuth) -> Response:
    return await _forward(request, _upstream_path(request.method, "datasets"))


@router.api_route(
    "/datasets/{subpath:path}", methods=["GET", "POST", "PATCH"], include_in_schema=False
)
@limiter.shared_limit(
    resolve_limit, scope=BUCKET_READ, key_func=key_read, exempt_when=is_request_rate_limit_exempt
)
async def datasets_sub(subpath: str, request: Request, auth: KeyStampedAuth) -> Response:
    return await _forward(request, _upstream_path(request.method, "datasets", subpath))


# --- Dataset versions (pull an immutable snapshot) --------------------------
@router.api_route("/dataset-versions/{subpath:path}", methods=["GET"], include_in_schema=False)
@limiter.shared_limit(
    resolve_limit, scope=BUCKET_READ, key_func=key_read, exempt_when=is_request_rate_limit_exempt
)
async def dataset_versions(subpath: str, request: Request, auth: KeyStampedAuth) -> Response:
    return await _forward(request, _upstream_path(request.method, "dataset-versions", subpath))


# --- Evaluation runs (Phase-4 write path) -----------------------------------
# The three reporting endpoints are explicit, typed, and published to OpenAPI so
# the CLI can codegen a real client. They still forward the (now request-validated)
# body to the Prisma-owned Next.js handlers — no persistence is duplicated here.
# The response_model documents the success shape; the actual body is the upstream
# response passed through by ``_forward``. These are registered before the catch-all
# below so they win for their exact paths.

_EVAL_ERROR_RESPONSES: dict[int | str, dict[str, Any]] = {
    400: {"model": ErrorResponse, "description": "Invalid request"},
    404: {"model": ErrorResponse, "description": "Not found"},
    413: {"model": ErrorResponse, "description": "Request body too large"},
    # FastAPI raises RequestValidationError (422) for a malformed body; `main.py`
    # normalizes it into this same {"detail": "<string>"} envelope, so declaring it
    # here keeps the published contract and the runtime response in agreement.
    422: {"model": ErrorResponse, "description": "Validation error"},
}


@router.post(
    "/evaluation-runs",
    operation_id="register_run",
    response_model=RegisterRunResponse,
    status_code=status.HTTP_201_CREATED,
    responses=_EVAL_ERROR_RESPONSES,
    summary="Register an evaluation run",
)
@limiter.shared_limit(
    resolve_limit,
    scope=BUCKET_INGEST,
    key_func=key_ingest,
    exempt_when=is_request_rate_limit_exempt,
)
async def register_run(
    payload: RegisterRunRequest, request: Request, auth: KeyStampedAuth
) -> Response:
    """Register/start a run. Idempotent on ``client_run_id`` within an evaluation."""
    return await _forward(request, _upstream_path(request.method, "evaluation-runs"))


@router.post(
    "/evaluation-runs/{run_id}/results",
    operation_id="upsert_result",
    response_model=UpsertResultResponse,
    responses=_EVAL_ERROR_RESPONSES,
    summary="Upsert one test-case result with scores",
)
@limiter.shared_limit(
    resolve_limit,
    scope=BUCKET_INGEST,
    key_func=key_ingest,
    exempt_when=is_request_rate_limit_exempt,
)
async def upsert_result(
    run_id: str, payload: UpsertResultRequest, request: Request, auth: KeyStampedAuth
) -> Response:
    """Upsert one test-case result (and its scores). Idempotent on (run, test case)."""
    subpath = _upstream_path(request.method, "evaluation-runs", run_id, "results")
    return await _forward(request, subpath)


@router.post(
    "/evaluation-runs/{run_id}/complete",
    operation_id="complete_run",
    response_model=CompleteRunResponse,
    responses=_EVAL_ERROR_RESPONSES,
    summary="Complete/finalize an evaluation run",
)
@limiter.shared_limit(
    resolve_limit,
    scope=BUCKET_INGEST,
    key_func=key_ingest,
    exempt_when=is_request_rate_limit_exempt,
)
async def complete_run(
    run_id: str, payload: CompleteRunRequest, request: Request, auth: KeyStampedAuth
) -> Response:
    """Complete/fail a run, reporting final completeness counts."""
    subpath = _upstream_path(request.method, "evaluation-runs", run_id, "complete")
    return await _forward(request, subpath)


# Remaining untyped run subpaths (additive per-scorer scores, human review) stay a
# hidden catch-all until they're typed in a later phase. Registered last so it does
# not shadow the explicit routes above.
@router.api_route("/evaluation-runs/{subpath:path}", methods=["POST"], include_in_schema=False)
@limiter.shared_limit(
    resolve_limit,
    scope=BUCKET_INGEST,
    key_func=key_ingest,
    exempt_when=is_request_rate_limit_exempt,
)
async def evaluation_runs_sub(subpath: str, request: Request, auth: KeyStampedAuth) -> Response:
    return await _forward(request, _upstream_path(request.method, "evaluation-runs", subpath))
