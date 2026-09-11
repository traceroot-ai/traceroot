"""Shared proxy for reads delegated to the Next.js internal routes.

Catalog data (dashboards, alerts) lives in Postgres/Prisma, so the public and
internal read routers delegate to secret-authed Next.js routes keyed by the
resolved project id. This module owns the one HTTP call and its error
mapping so every read common uses the same rules: client errors the internal
route owns (400/403/404) pass through with the upstream ``error`` string as
the public ``detail``; everything ambiguous — a network error, an upstream
401 (our own secret being rejected), an unexpected status, or a malformed
body — fails closed as a controlled 503. Ids are never logged.
"""

import logging

import httpx
from fastapi import HTTPException, status

from shared.config import settings

logger = logging.getLogger(__name__)

# Generic per-status fallbacks for a passthrough status whose upstream body
# carries no usable ``error`` string — the raw body is never surfaced.
_PASSTHROUGH_FALLBACKS = {
    status.HTTP_400_BAD_REQUEST: "Invalid request",
    status.HTTP_403_FORBIDDEN: "Forbidden",
    status.HTTP_404_NOT_FOUND: "Not found",
}


def service_error(service: str) -> HTTPException:
    """Build the controlled 503 used whenever an internal read is ambiguous.

    A shared fail-closed error so any upstream ambiguity — an unexpected
    status, malformed JSON, or a body missing a required field — surfaces as a
    503, never an uncaught 500 (parity with the account-read sibling).

    Args:
        service (str): The catalog's display name for the detail, e.g.
            ``"Dashboard"`` or ``"Alert"``.

    Returns:
        HTTPException: A 503 with a generic ``<service> service error`` detail.
    """
    return HTTPException(
        status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
        detail=f"{service} service error",
    )


async def post_internal_read(path: str, payload: dict, *, service: str) -> dict:
    """POST a read to an internal route and return its success body.

    Args:
        path (str): Internal route path (appended to the UI base URL), e.g.
            ``"/api/internal/project-dashboards"``.
        payload (dict): The camelCase JSON body to POST (resolved project /
            resource ids; never logged).
        service (str): The catalog's display name for logs and 503 details.

    Returns:
        dict: The parsed 200 response body.

    Raises:
        HTTPException: 400/403/404 passed through from the internal route with
            its own ``error`` string as ``detail``; 503 (fail closed) on a
            network error, an upstream 401, any other unexpected status, or a
            malformed body.
    """
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            response = await client.post(
                # rstrip: a trailing slash on the setting must not double up.
                f"{settings.traceroot_ui_url.rstrip('/')}{path}",
                json=payload,
                headers={"X-Internal-Secret": settings.internal_api_secret},
            )
    except httpx.RequestError as e:
        logger.error(f"Failed to reach the {service.lower()} service: {e}")
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=f"{service} service unavailable",
        ) from e

    if response.status_code in _PASSTHROUGH_FALLBACKS:
        fallback = _PASSTHROUGH_FALLBACKS[response.status_code]
        try:
            body = response.json()
        except ValueError:
            body = None
        error = body.get("error") if isinstance(body, dict) else None
        raise HTTPException(
            status_code=response.status_code,
            detail=error if isinstance(error, str) and error else fallback,
        )

    if response.status_code != 200:
        # Includes 401: the internal secret is this service's own credential,
        # so an upstream rejection of it is our misconfiguration — an outage
        # from the caller's point of view, never their auth failing.
        logger.error(
            f"Unexpected response from the {service.lower()} service: {response.status_code}"
        )
        raise service_error(service)

    try:
        data = response.json()
    except ValueError as e:
        logger.error(f"Malformed JSON from the {service.lower()} service: {e}")
        raise service_error(service) from e

    if not isinstance(data, dict):
        logger.error(f"{service} service returned a non-object JSON body")
        raise service_error(service)

    return data
