"""Shared authentication dependency for every internal endpoint."""

import hmac
from typing import Annotated, Literal

from fastapi import Header, HTTPException

from shared.config import settings

InternalCaller = Literal["platform", "agent"]


def _matches(header: str, secret: str) -> bool:
    # Empty configured secrets never match: an unset agent secret must not let an
    # empty header through. Compare bytes: str compare_digest raises on the
    # non-ASCII strs latin-1 headers produce.
    return bool(secret) and hmac.compare_digest(header.encode(), secret.encode())


def verify_internal_secret(
    x_internal_secret: Annotated[str | None, Header()] = None,
) -> InternalCaller:
    """Verify the internal API secret and identify the caller.

    Two credentials are recognised: the platform secret (worker, Next.js server;
    env INTERNAL_API_SECRET) and the agent-service secret (INTERNAL_API_SECRET_AGENT).
    Fails closed: a missing platform secret rejects every request with 503 rather
    than silently allowing them.

    Returns:
        InternalCaller: "platform" or "agent" — routes that care which process is
            calling (the trace ingest route stamps `source` from it) depend on the
            return value; every other route just uses the dependency for its guard.
    """
    if not settings.internal_api_secret:
        raise HTTPException(
            status_code=503,
            detail="INTERNAL_API_SECRET not configured on server",
        )
    if not x_internal_secret:
        raise HTTPException(status_code=403, detail="Invalid internal secret")
    if _matches(x_internal_secret, settings.internal_api_secret):
        return "platform"
    if _matches(x_internal_secret, settings.internal_api_secret_agent):
        return "agent"
    raise HTTPException(status_code=403, detail="Invalid internal secret")
