"""Rate limiting for the Traceroot REST API.

Architecture
------------
Uses `slowapi` (built on the `limits` library) with Redis storage so limits
are shared across every API replica — no per-process state drift in
multi-instance deployments.

Automatic in-memory fallback (`in_memory_fallback_enabled=True`) keeps the
API available when Redis is temporarily unreachable; limits are then enforced
per-process until Redis recovers.

Key-extraction strategy
-----------------------
* Public ingestion endpoints  → bucket per **API key** (SHA-256 prefix).
* Authenticated dashboard API → bucket per **user ID** (x-user-id header).
* Everything else             → bucket per **client IP** (ultimate fallback).

Usage
-----
In a router module::

    from rest.rate_limit import limiter, key_by_api_key
    from shared.config import settings

    @router.post("")
    @limiter.limit(settings.rate_limit.ingestion, key_func=key_by_api_key)
    async def my_endpoint(request: Request, ...):
        ...

Note: the endpoint **must** declare ``request: Request`` and ``response: Response``
(Starlette/FastAPI) so slowapi can attach ``X-RateLimit-*`` headers when the
handler returns a Pydantic model instead of a ``Response`` instance.
"""

import hashlib
import logging

from fastapi import Request
from fastapi.responses import JSONResponse
from slowapi import Limiter
from slowapi.errors import RateLimitExceeded
from slowapi.util import get_remote_address
from starlette.requests import Request as StarletteRequest

from shared.config import settings

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Key-extraction functions
# ---------------------------------------------------------------------------


def key_by_api_key(request: Request) -> str:
    """Return a stable rate-limit bucket key derived from the Bearer API key.

    Uses the first 24 hex characters of the SHA-256 digest so the raw secret
    never appears in Redis keys while still providing per-key isolation.
    Falls back to the client IP address when the Authorization header is absent.
    """
    auth = request.headers.get("authorization", "")
    if auth.lower().startswith("bearer "):
        raw_key = auth[7:]
        digest = hashlib.sha256(raw_key.encode()).hexdigest()[:24]
        return f"apikey:{digest}"
    return f"ip:{get_remote_address(request)}"


def key_by_user_id(request: Request) -> str:
    """Return a stable rate-limit bucket key derived from the authenticated user ID.

    Falls back to the client IP address when the *x-user-id* header is absent,
    e.g. in automated tests that bypass the Next.js authentication layer.
    """
    user_id = request.headers.get("x-user-id")
    if user_id:
        return f"user:{user_id}"
    return f"ip:{get_remote_address(request)}"


# ---------------------------------------------------------------------------
# Exception handler
# ---------------------------------------------------------------------------


def rate_limit_exceeded_handler(
    request: StarletteRequest,
    exc: RateLimitExceeded,
) -> JSONResponse:
    """Return a JSON 429 response consistent with the rest of the API error format."""
    retry_after = getattr(exc, "retry_after", 60)
    return JSONResponse(
        status_code=429,
        content={
            "detail": f"Rate limit exceeded: {exc.detail}. Retry after {retry_after}s.",
            "error": "too_many_requests",
            "retry_after": retry_after,
        },
        headers={"Retry-After": str(retry_after)},
    )


# ---------------------------------------------------------------------------
# Limiter singleton
# ---------------------------------------------------------------------------


def _build_limiter() -> Limiter:
    """Construct the application-wide Limiter with Redis storage.

    Falls back to in-memory storage when Redis is unavailable so the API
    remains operational during cache outages (limits are then per-process).
    """
    storage_uri = settings.rate_limit.storage_uri or settings.redis.url
    logger.info("Initialising rate limiter (storage: %s)", storage_uri)
    return Limiter(
        key_func=get_remote_address,  # default; each endpoint overrides via key_func=
        storage_uri=storage_uri,
        headers_enabled=True,  # X-RateLimit-* response headers
        in_memory_fallback_enabled=True,  # survive Redis outages
        swallow_errors=False,  # surface mis-configurations in dev/test
    )


limiter: Limiter = _build_limiter()
