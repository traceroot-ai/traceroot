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
    # Compare bytes: str compare_digest raises on the non-ASCII strs latin-1 headers produce.
    if not x_internal_secret or not hmac.compare_digest(
        x_internal_secret.encode(), settings.internal_api_secret.encode()
    ):
        raise HTTPException(status_code=403, detail="Invalid internal secret")
