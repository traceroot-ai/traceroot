"""Verification of OAuth access tokens issued by the web app's OAuth provider.

These are the credentials an assistant connector (an MCP client) holds after a
user signs in and consents. They are signed with the same key set as the CLI
access JWT but are a different credential class, so they are told apart by issuer
and held to stricter rules than a CLI token:

- the audience must be one of the configured resource URLs (the MCP server), so
  a token minted for another resource is refused;
- the token carries one project (``project_id``) the user chose at consent, and
  that project, not a caller-supplied one, decides what it can read;
- it must carry the ``mcp:read`` scope; nothing here grants a write.

Fail-closed: with no issuer or audience configured, no token is accepted.
"""

import logging
from dataclasses import dataclass

import jwt
from fastapi import HTTPException, status

from rest.routers.public.jwks_cache import JwksCache, JwksUnavailableError
from shared.config import settings

logger = logging.getLogger(__name__)

OAUTH_READ_SCOPE = "mcp:read"
_CLOCK_SKEW_LEEWAY_SECONDS = 30


@dataclass(frozen=True)
class OAuthClaims:
    """The verified claims an OAuth access token carries."""

    user_id: str
    project_id: str
    client_id: str
    token_id: str


def configured_audiences() -> list[str]:
    """Return the resource URLs a token may be minted for (empty disables OAuth)."""
    return [a.strip() for a in settings.traceroot_oauth_audiences.split(",") if a.strip()]


def is_oauth_token(token: str) -> bool:
    """Return whether a JWT names the configured OAuth issuer.

    Only routes the token to the right verifier; it proves nothing. The signature
    is checked by :func:`verify_oauth_access_token`.

    Args:
        token (str): A JWT-shaped bearer token.

    Returns:
        bool: ``True`` when the unverified ``iss`` equals the configured issuer.
    """
    issuer = settings.traceroot_oauth_issuer
    if not issuer:
        return False
    try:
        claims = jwt.decode(token, options={"verify_signature": False})
    except jwt.InvalidTokenError:
        return False
    return claims.get("iss") == issuer


async def verify_oauth_access_token(token: str, jwks: JwksCache) -> OAuthClaims:
    """Verify an OAuth access token offline and return its claims.

    Pins ``EdDSA``, the issuer, the audience, expiry, the read scope and the
    presence of the project, client and token-id claims.

    Args:
        token (str): The raw JWT. Never logged.
        jwks (JwksCache): The cache holding the web app's public signing keys.

    Returns:
        OAuthClaims: The verified claims.

    Raises:
        HTTPException: 401 for any verification failure; 503 (fail closed) if the
            signing keys cannot be fetched.
    """
    invalid = HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid token")
    audiences = configured_audiences()
    if not settings.traceroot_oauth_issuer or not audiences:
        raise invalid

    try:
        header = jwt.get_unverified_header(token)
    except jwt.InvalidTokenError:
        raise invalid from None
    kid = header.get("kid")
    if not kid or not isinstance(kid, str):
        raise invalid

    try:
        signing_key = await jwks.get_signing_key(kid)
    except JwksUnavailableError as e:
        logger.error(f"JWKS unavailable while verifying OAuth token: {e}")
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Authentication service error",
        ) from e
    if signing_key is None:
        raise invalid

    try:
        claims = jwt.decode(
            token,
            signing_key.key,
            algorithms=["EdDSA"],
            audience=audiences,
            issuer=settings.traceroot_oauth_issuer,
            leeway=_CLOCK_SKEW_LEEWAY_SECONDS,
            options={"require": ["exp", "sub", "iss", "aud", "jti"]},
        )
    except jwt.InvalidTokenError:
        raise invalid from None

    scope = claims.get("scope")
    if not isinstance(scope, str) or OAUTH_READ_SCOPE not in scope.split():
        raise invalid

    values = {k: claims.get(k) for k in ("sub", "project_id", "client_id", "jti")}
    if not all(isinstance(v, str) and v for v in values.values()):
        raise invalid
    return OAuthClaims(
        user_id=values["sub"],
        project_id=values["project_id"],
        client_id=values["client_id"],
        token_id=values["jti"],
    )
