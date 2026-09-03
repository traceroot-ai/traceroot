"""Shared authentication dependency for every internal endpoint."""

import hmac
from typing import Annotated

from fastapi import Header, HTTPException

from shared.config import settings


def verify_internal_secret(
    x_internal_secret: Annotated[str | None, Header()] = None,
) -> None:
    """Verify the internal API secret.

    Fails closed: a missing or empty server-side secret rejects all requests
    rather than silently allowing them. (Previous behavior treated an empty
    secret as "dev mode allow-all", which left the new detector write
    endpoints open to anonymous writes whenever the env var was unset.)
    """
    if not settings.internal_api_secret:
        raise HTTPException(
            status_code=503,
            detail="INTERNAL_API_SECRET not configured on server",
        )
    # Starlette latin-1-decodes header bytes; latin-1 re-encoding recovers the wire
    # bytes so a UTF-8 secret matches its config value. Bytes: str compare_digest
    # raises on non-ASCII.
    if not x_internal_secret or not hmac.compare_digest(
        x_internal_secret.encode("latin-1"), settings.internal_api_secret.encode()
    ):
        raise HTTPException(status_code=403, detail="Invalid internal secret")
