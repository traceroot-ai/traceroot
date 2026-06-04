"""Shared dependencies for the public, API-key-authenticated API.

The API-key auth dependency lives here (not inside any one endpoint module) so
every public route — ingestion plus the read endpoints (whoami, traces) — can
depend on it without importing from a sibling endpoint. Authentication is
delegated to the Next.js internal ``validate-api-key`` route, which owns the
Postgres/Prisma control-plane data.
"""

import hashlib
import logging
from dataclasses import dataclass
from typing import Annotated

import httpx
from fastapi import Depends, Header, HTTPException, status

from shared.config import settings

logger = logging.getLogger(__name__)


@dataclass
class AuthResult:
    """Result of API key authentication.

    The billing fields drive ingestion gating. The identity fields
    (``project_name``/``workspace_name``/``key_name``/``key_hint``) power the
    ``whoami`` endpoint; they are optional because ``validate-api-key`` may not
    return them, and ingestion does not need them.
    """

    project_id: str
    workspace_id: str
    billing_plan: str
    ingestion_blocked: bool
    project_name: str | None = None
    workspace_name: str | None = None
    key_name: str | None = None
    key_hint: str | None = None


async def authenticate_api_key(
    authorization: Annotated[str | None, Header()] = None,
) -> AuthResult:
    """Authenticate the request via the Next.js internal validate-api-key route.

    Expects ``Authorization: Bearer <api_key>``. The raw key is hashed before it
    leaves this process; the full token is never forwarded or logged.
    """
    if not authorization:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Missing Authorization header",
        )

    parts = authorization.split(" ", 1)
    if len(parts) != 2 or parts[0].lower() != "bearer":
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid Authorization header format. Expected: Bearer <api_key>",
        )

    api_key = parts[1]
    # SHA256 is appropriate for API keys (high-entropy random UUIDs, not user passwords).
    # codeql[py/weak-sensitive-data-hashing]
    key_hash = hashlib.sha256(api_key.encode()).hexdigest()

    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            response = await client.post(
                f"{settings.traceroot_ui_url}/api/internal/validate-api-key",
                json={"keyHash": key_hash},
                headers={"X-Internal-Secret": settings.internal_api_secret},
            )
    except httpx.RequestError as e:
        logger.error(f"Failed to validate API key: {e}")
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Authentication service unavailable",
        ) from e

    if response.status_code == 401:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Authentication failed",
        )

    if response.status_code != 200:
        logger.error(f"Unexpected response from auth service: {response.status_code}")
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Authentication service error",
        )

    data = response.json()

    if not data.get("valid"):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail=data.get("error", "Invalid API key"),
        )

    return AuthResult(
        project_id=data["projectId"],
        workspace_id=data["workspaceId"],
        billing_plan=data["billingPlan"],
        ingestion_blocked=data.get("ingestionBlocked", False),
        project_name=data.get("projectName"),
        workspace_name=data.get("workspaceName"),
        key_name=data.get("keyName"),
        key_hint=data.get("keyHint"),
    )


Auth = Annotated[AuthResult, Depends(authenticate_api_key)]
