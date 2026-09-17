"""Shared authentication dependency for every internal endpoint."""

import hmac
from typing import Annotated, Literal

from fastapi import Header, HTTPException

from shared.config import settings

InternalCaller = Literal["platform", "agent"]


def _matches(header: str, secret: str) -> bool:
    # Empty configured secrets never match: an unset agent secret must not let an
    # empty header through. Compare bytes: str compare_digest raises on the
    # non-ASCII strs latin-1 headers produce. Starlette latin-1-decodes header
    # bytes, so latin-1 re-encoding recovers the wire bytes and a UTF-8 secret
    # matches its config value.
    return bool(secret) and hmac.compare_digest(header.encode("latin-1"), secret.encode())


def internal_caller(x_internal_secret: str | None) -> InternalCaller | None:
    """Which internal credential a header carries, or None for neither.

    The one matcher for both secrets, so every site that trusts internal
    traffic trusts the same set: the internal router's dependency below and
    the app routes' system bypass (`routers/deps.get_project_access`), which
    the agent's own tools reach. A site that checked only the platform secret
    would 401 the agent service, which holds only its own (design: agent
    self-trace, decision 2).

    Args:
        x_internal_secret: The `X-Internal-Secret` header, if any.

    Returns:
        InternalCaller | None: "platform", "agent", or None when the header is
            absent, empty, or matches neither configured secret.
    """
    if not x_internal_secret:
        return None
    if _matches(x_internal_secret, settings.internal_api_secret):
        return "platform"
    if _matches(x_internal_secret, settings.internal_api_secret_agent):
        return "agent"
    return None


def verify_internal_secret(
    x_internal_secret: Annotated[str | None, Header()] = None,
) -> InternalCaller:
    """Verify the internal API secret and identify the caller.

    Two credentials are recognised: the platform secret (worker, Next.js server;
    env INTERNAL_API_SECRET) and the agent-service secret (INTERNAL_API_SECRET_AGENT).
    They differ in the `source` the ingest route stamps, not in privilege: either
    one unlocks every internal route. The split keeps an external client from
    choosing its source; it does not stop a process holding both secrets from
    labelling its traces with the other one.
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
    caller = internal_caller(x_internal_secret)
    if caller is None:
        raise HTTPException(status_code=403, detail="Invalid internal secret")
    return caller
