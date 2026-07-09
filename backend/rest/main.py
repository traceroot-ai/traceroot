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
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from slowapi.errors import RateLimitExceeded

from rest.rate_limit import limiter, rate_limit_exceeded_handler
from rest.routers.internal import router as internal_router
from rest.routers.live import router as live_router
from rest.routers.public.detectors_read import router as public_detectors_read_router
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
    description="Observability platform for LLM applications",
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

# Live trace streaming (SSE, user auth)
app.include_router(live_router, prefix="/api/v1")

# Public API for SDK ingestion (API key auth)
app.include_router(public_traces_router, prefix="/api/v1")

# Public read API for API-key clients (e.g. the CLI)
app.include_router(public_whoami_router, prefix="/api/v1")
app.include_router(public_traces_read_router, prefix="/api/v1")
app.include_router(public_detectors_read_router, prefix="/api/v1")

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
