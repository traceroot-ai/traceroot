"""JWKS cache for verifying CLI access JWTs offline.

The CLI presents a short-lived EdDSA JWT (minted by the Next.js app's ``jwt()``
plugin); the app serves the public signing keys at ``{ui}/api/auth/jwks``. This
caches those keys so the backend verifies each JWT's signature locally, without a
per-request round-trip to the app.

Fail-closed by construction: if the keys cannot be fetched or parsed, the lookup
raises :class:`JwksUnavailableError` (mapped to a controlled 503 upstream) rather
than letting an unverified token through. An unknown ``kid`` returns ``None`` (an
untrusted token → 401 upstream). Rotation is picked up within the TTL, and an
unknown-kid refetch is rate-limited so a flood of random kids can't force
unbounded fetches.
"""

import asyncio
import logging
import time

import httpx
from jwt import PyJWK, PyJWKSet

from shared.config import settings

logger = logging.getLogger(__name__)

_JWKS_PATH = "/api/auth/jwks"
_DEFAULT_TTL_SECONDS = 300
_MIN_REFETCH_INTERVAL_SECONDS = 10


class JwksUnavailableError(Exception):
    """Raised when the JWKS cannot be fetched or parsed (verification fails closed)."""


class JwksCache:
    """Async, TTL'd cache of the app's JWKS, indexed by key id (``kid``)."""

    def __init__(
        self,
        jwks_url: str,
        ttl_seconds: int = _DEFAULT_TTL_SECONDS,
        min_refetch_interval_seconds: int = _MIN_REFETCH_INTERVAL_SECONDS,
    ) -> None:
        self._jwks_url = jwks_url
        self._ttl_seconds = ttl_seconds
        self._min_refetch_interval_seconds = min_refetch_interval_seconds
        self._keys: dict[str, PyJWK] = {}
        self._fetched_at: float | None = None
        self._lock = asyncio.Lock()

    async def get_signing_key(self, kid: str) -> PyJWK | None:
        """Return the signing key for ``kid``, refreshing on a stale cache or a miss.

        Args:
            kid: The key id from the JWT header.

        Returns:
            The matching :class:`PyJWK`, or ``None`` when ``kid`` is unknown even
            after a refresh (an untrusted token).

        Raises:
            JwksUnavailableError: If the JWKS cannot be fetched or parsed.
        """
        cached = self._keys.get(kid)
        if cached is not None and self._is_fresh():
            return cached

        async with self._lock:
            # Re-check under the lock — another task may have just refreshed.
            cached = self._keys.get(kid)
            if cached is not None and self._is_fresh():
                return cached
            # Refresh when the cache is stale, or when the kid is unknown and a
            # rotation-catching refetch is allowed (bounded so an attacker sending
            # tokens with random kids cannot force unbounded refetches).
            if not self._is_fresh() or self._may_refetch_for_unknown_kid():
                await self._refresh()
            return self._keys.get(kid)

    def _is_fresh(self) -> bool:
        return (
            self._fetched_at is not None
            and (time.monotonic() - self._fetched_at) < self._ttl_seconds
        )

    def _may_refetch_for_unknown_kid(self) -> bool:
        return (
            self._fetched_at is None
            or (time.monotonic() - self._fetched_at) >= self._min_refetch_interval_seconds
        )

    async def _refresh(self) -> None:
        try:
            async with httpx.AsyncClient(timeout=10.0) as client:
                response = await client.get(self._jwks_url)
            response.raise_for_status()
            jwk_set = PyJWKSet.from_dict(response.json())
        except (httpx.HTTPError, ValueError, KeyError, TypeError) as e:
            logger.error(f"Failed to fetch JWKS: {e}")
            raise JwksUnavailableError("Could not fetch signing keys") from e

        self._keys = {key.key_id: key for key in jwk_set.keys if key.key_id}
        self._fetched_at = time.monotonic()


_default_cache: JwksCache | None = None


def get_jwks_cache() -> JwksCache:
    """Return the process-wide JWKS cache (lazy so settings are loaded first)."""
    global _default_cache
    if _default_cache is None:
        _default_cache = JwksCache(f"{settings.traceroot_ui_url}{_JWKS_PATH}")
    return _default_cache
