"""Shared authentication dependency for every internal endpoint."""

import hmac
from typing import Annotated

from fastapi import Header, HTTPException

from shared.config import settings


def _matches(header: str, secret: str) -> bool:
    # Empty configured secrets never match: an unset agent secret must not let an
    # empty header through. Compare bytes: str compare_digest raises on the
    # non-ASCII strs latin-1 headers produce. Starlette latin-1-decodes header
    # bytes, so latin-1 re-encoding recovers the wire bytes and a UTF-8 secret
    # matches its config value.
    return bool(secret) and hmac.compare_digest(header.encode("latin-1"), secret.encode())


def has_internal_secret(x_internal_secret: str | None) -> bool:
    """Whether a header carries the internal secret.

    The one matcher, so every site that trusts internal traffic trusts the
    same thing: the internal router's dependency below and the app routes'
    system bypass (`routers/deps.get_project_access`), which the agent
    service's tools reach.

    Args:
        x_internal_secret: The `X-Internal-Secret` header, if any.

    Returns:
        bool: True only for a non-empty header matching a configured secret.
    """
    return bool(x_internal_secret) and _matches(
        x_internal_secret or "", settings.internal_api_secret
    )


def verify_internal_secret(
    x_internal_secret: Annotated[str | None, Header()] = None,
) -> None:
    """Verify the internal API secret on a server-to-server call.

    One credential for every internal caller (worker, Next.js server, agent
    service). Which `source` a trace is stored under is decided by the ingest
    path the caller reached, not by who authenticated: the label separates
    reading and billing, not privilege, and a single secret is one fewer
    required value in every deployment (design: decision 2).

    Fails closed: an unset secret rejects every request with 503 rather than
    silently allowing them.
    """
    if not settings.internal_api_secret:
        raise HTTPException(
            status_code=503,
            detail="INTERNAL_API_SECRET not configured on server",
        )
    if not has_internal_secret(x_internal_secret):
        raise HTTPException(status_code=403, detail="Invalid internal secret")
