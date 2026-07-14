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

Auth is enforced here (``authenticate_api_key``, same as every public route) and
the Bearer key is forwarded so the Next.js handler re-validates authoritatively
against Postgres.
"""

import logging
from typing import Annotated, Any

import httpx
from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from fastapi.responses import JSONResponse

from rest.routers.public.deps import AuthResult, authenticate_api_key
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

Auth = Annotated[AuthResult, Depends(authenticate_api_key)]

# Forward everything except hop-by-hop / host-specific headers.
_SKIP_REQUEST_HEADERS = {"host", "content-length", "connection", "accept-encoding"}

# Shown when an upstream failure carries no usable message (non-JSON body, HTML
# error page, unexpected structure). Deliberately generic so nothing internal leaks.
_GENERIC_UPSTREAM_ERROR = "Evaluation request failed"


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
    return JSONResponse(status_code=upstream.status_code, content={"detail": detail})


async def _forward(request: Request, subpath: str) -> Response:
    """Proxy the current request to the Next.js ``/api/public/<subpath>`` route.

    Successful (2xx/3xx) responses pass through verbatim. Upstream failures are
    normalized to ``{"detail": ...}`` (see ``_normalized_error``); a transport
    failure reaching the control plane is a native 503 in the same shape.
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
@router.api_route("/datasets", methods=["GET", "POST"], include_in_schema=False)
async def datasets_root(request: Request, auth: Auth) -> Response:
    return await _forward(request, "datasets")


@router.api_route(
    "/datasets/{subpath:path}", methods=["GET", "POST", "PATCH"], include_in_schema=False
)
async def datasets_sub(subpath: str, request: Request, auth: Auth) -> Response:
    return await _forward(request, f"datasets/{subpath}")


# --- Dataset versions (pull an immutable snapshot) --------------------------
@router.api_route("/dataset-versions/{subpath:path}", methods=["GET"], include_in_schema=False)
async def dataset_versions(subpath: str, request: Request, auth: Auth) -> Response:
    return await _forward(request, f"dataset-versions/{subpath}")


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
}


@router.post(
    "/evaluation-runs",
    response_model=RegisterRunResponse,
    status_code=status.HTTP_201_CREATED,
    responses=_EVAL_ERROR_RESPONSES,
    summary="Register an evaluation run",
)
async def register_run(payload: RegisterRunRequest, request: Request, auth: Auth) -> Response:
    """Register/start a run. Idempotent on ``client_run_id`` within an evaluation."""
    return await _forward(request, "evaluation-runs")


@router.post(
    "/evaluation-runs/{run_id}/results",
    response_model=UpsertResultResponse,
    responses=_EVAL_ERROR_RESPONSES,
    summary="Upsert one test-case result with scores",
)
async def upsert_result(
    run_id: str, payload: UpsertResultRequest, request: Request, auth: Auth
) -> Response:
    """Upsert one test-case result (and its scores). Idempotent on (run, test case)."""
    return await _forward(request, f"evaluation-runs/{run_id}/results")


@router.post(
    "/evaluation-runs/{run_id}/complete",
    response_model=CompleteRunResponse,
    responses=_EVAL_ERROR_RESPONSES,
    summary="Complete/finalize an evaluation run",
)
async def complete_run(
    run_id: str, payload: CompleteRunRequest, request: Request, auth: Auth
) -> Response:
    """Complete/fail a run, reporting final completeness counts."""
    return await _forward(request, f"evaluation-runs/{run_id}/complete")


# Remaining untyped run subpaths (additive per-scorer scores, human review) stay a
# hidden catch-all until they're typed in a later phase. Registered last so it does
# not shadow the explicit routes above.
@router.api_route("/evaluation-runs/{subpath:path}", methods=["POST"], include_in_schema=False)
async def evaluation_runs_sub(subpath: str, request: Request, auth: Auth) -> Response:
    return await _forward(request, f"evaluation-runs/{subpath}")
