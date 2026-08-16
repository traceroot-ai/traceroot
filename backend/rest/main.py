"""FastAPI REST API server for TraceRoot.

This server handles:
- OTEL trace ingestion (public API with API key auth)
- Trace reading from ClickHouse
"""

import os

from dotenv import load_dotenv

# Load environment variables from .env file
load_dotenv()

import uvicorn
from fastapi import FastAPI, Request
from fastapi.exception_handlers import request_validation_exception_handler
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import JSONResponse
from slowapi.errors import RateLimitExceeded
from starlette.responses import Response

from rest.openapi_public import PUBLIC_PREFIX
from rest.rate_limit import limiter, rate_limit_exceeded_handler
from rest.routers.dashboards import router as dashboards_router
from rest.routers.internal import router as internal_router
from rest.routers.live import router as live_router
from rest.routers.public.detectors_read import router as public_detectors_read_router
from rest.routers.public.eval import router as public_eval_router
from rest.routers.public.sessions_read import router as public_sessions_read_router
from rest.routers.public.traces import router as public_traces_router
from rest.routers.public.traces_read import router as public_traces_read_router
from rest.routers.public.whoami import router as public_whoami_router
from rest.routers.sessions import router as sessions_router
from rest.routers.traces import router as traces_router
from rest.routers.users import router as users_router
from rest.schemas.common import HealthResponse
from shared.config import settings

app = FastAPI(
    title="TraceRoot API",
    description="Observability and self-improving layer for AI agents",
    version="0.1.0",
)

# Compress responses (e.g. large trace payloads). Added before CORS so that
# CORS remains the outermost middleware and its headers apply to every
# response, including gzipped ones.
app.add_middleware(GZipMiddleware, minimum_size=1024)

# Rate limiting. Enforcement + X-RateLimit-* headers are handled by the
# per-route @limiter decorators (see rest.rate_limit); SlowAPIMiddleware is
# intentionally omitted because it exempts decorated routes anyway. The limiter
# is attached to app.state so the 429 handler can read window stats for headers.
app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, rate_limit_exceeded_handler)


def _validation_message(exc: RequestValidationError) -> str:
    """Collapse a pydantic error list into one human-readable sentence."""
    errors = exc.errors()
    if not errors:
        return "Invalid request"
    first = errors[0]
    # loc[0] is the source ("body"/"query"/"path"); the rest is the field path.
    location = ".".join(str(part) for part in tuple(first.get("loc") or ())[1:])
    message = str(first.get("msg") or "Invalid request")
    detail = f"{location}: {message}" if location else message
    remaining = len(errors) - 1
    return f"{detail} (and {remaining} more error(s))" if remaining else detail


@app.exception_handler(RequestValidationError)
async def validation_exception_handler(request: Request, exc: RequestValidationError) -> Response:
    """Give the public API a single error envelope for request-validation failures.

    Every documented `/api/v1/public/*` error body is `{"detail": "<string>"}`, but
    FastAPI's default 422 puts a *list of error objects* under `detail` — so an SDK
    that formats `resp.json()["detail"]` as a message renders a repr'd list. Public
    routes therefore get the same string envelope their upstream/handler errors use.
    Non-public (dashboard/internal) routes keep FastAPI's default body, which the
    Next.js app already parses.
    """
    if not request.url.path.startswith(PUBLIC_PREFIX):
        return await request_validation_exception_handler(request, exc)
    return JSONResponse(status_code=422, content={"detail": _validation_message(exc)})


# CORS configuration
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Trace reading from ClickHouse (user auth via headers from Next.js)
app.include_router(traces_router, prefix="/api/v1")
app.include_router(users_router, prefix="/api/v1")
app.include_router(sessions_router, prefix="/api/v1")
app.include_router(dashboards_router, prefix="/api/v1")

# Live trace streaming (SSE, user auth)
app.include_router(live_router, prefix="/api/v1")

# Public API for SDK ingestion (API key auth)
app.include_router(public_traces_router, prefix="/api/v1")

# Public read API for API-key clients (e.g. the CLI)
app.include_router(public_whoami_router, prefix="/api/v1")
app.include_router(public_traces_read_router, prefix="/api/v1")
app.include_router(public_sessions_read_router, prefix="/api/v1")
app.include_router(public_detectors_read_router, prefix="/api/v1")

# Public offline-eval API (dataset authoring + run reporting). Thin authenticated
# proxy to the Next.js control-plane routes so the SDK stays single-host.
app.include_router(public_eval_router, prefix="/api/v1")

# Internal API for worker/service communication (protected by secret)
app.include_router(internal_router, prefix="/api/v1")


@app.get("/health", response_model=HealthResponse)
async def health_check() -> HealthResponse:
    """Health check endpoint."""
    return HealthResponse(status="ok")


if __name__ == "__main__":
    host = os.getenv("HOST", "0.0.0.0")
    port = int(os.getenv("PORT", "8000"))
    uvicorn.run(
        "rest.main:app",
        host=host,
        port=port,
    )
