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
from typing import Annotated

import httpx
from fastapi import APIRouter, Depends, HTTPException, Request, Response, status

from rest.routers.public.deps import AuthResult, authenticate_api_key
from shared.config import settings

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/public", tags=["Offline Eval (Public)"])

Auth = Annotated[AuthResult, Depends(authenticate_api_key)]

# Forward everything except hop-by-hop / host-specific headers.
_SKIP_REQUEST_HEADERS = {"host", "content-length", "connection", "accept-encoding"}


async def _forward(request: Request, subpath: str) -> Response:
    """Proxy the current request to the Next.js ``/api/public/<subpath>`` route."""
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


# --- Evaluation runs (register / results / scores / human-score / complete) -
@router.api_route("/evaluation-runs", methods=["POST"], include_in_schema=False)
async def evaluation_runs_root(request: Request, auth: Auth) -> Response:
    return await _forward(request, "evaluation-runs")


@router.api_route("/evaluation-runs/{subpath:path}", methods=["POST"], include_in_schema=False)
async def evaluation_runs_sub(subpath: str, request: Request, auth: Auth) -> Response:
    return await _forward(request, f"evaluation-runs/{subpath}")
