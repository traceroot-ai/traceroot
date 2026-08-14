"""Tests for the offline JWKS cache used to verify CLI access JWTs.

Uses a real Ed25519 keypair + respx-mocked JWKS endpoint.
"""

import httpx
import pytest
import respx
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from httpx import Response
from jwt.algorithms import OKPAlgorithm

from rest.routers.public.jwks_cache import JwksCache, JwksUnavailableError

BASE_URL = "http://localhost:3000"
JWKS_URL = f"{BASE_URL}/api/auth/jwks"


def _jwks(kid: str, priv: Ed25519PrivateKey) -> dict:
    jwk = OKPAlgorithm.to_jwk(priv.public_key(), as_dict=True)
    jwk["kid"] = kid
    jwk["alg"] = "EdDSA"
    jwk["use"] = "sig"
    return {"keys": [jwk]}


class TestJwksCache:
    @respx.mock
    async def test_fetches_and_returns_key_by_kid(self):
        priv = Ed25519PrivateKey.generate()
        route = respx.get(JWKS_URL).mock(return_value=Response(200, json=_jwks("kid-1", priv)))

        cache = JwksCache(JWKS_URL)
        key = await cache.get_signing_key("kid-1")

        assert key is not None
        assert key.key_id == "kid-1"
        assert route.call_count == 1

    @respx.mock
    async def test_serves_from_cache_without_refetch_while_fresh(self):
        priv = Ed25519PrivateKey.generate()
        route = respx.get(JWKS_URL).mock(return_value=Response(200, json=_jwks("kid-1", priv)))

        cache = JwksCache(JWKS_URL, ttl_seconds=300)
        await cache.get_signing_key("kid-1")
        await cache.get_signing_key("kid-1")

        assert route.call_count == 1  # second lookup served from cache

    @respx.mock
    async def test_refetches_after_ttl(self):
        priv = Ed25519PrivateKey.generate()
        route = respx.get(JWKS_URL).mock(return_value=Response(200, json=_jwks("kid-1", priv)))

        cache = JwksCache(JWKS_URL, ttl_seconds=0)  # immediately stale
        await cache.get_signing_key("kid-1")
        await cache.get_signing_key("kid-1")

        assert route.call_count == 2

    @respx.mock
    async def test_unknown_kid_returns_none(self):
        priv = Ed25519PrivateKey.generate()
        respx.get(JWKS_URL).mock(return_value=Response(200, json=_jwks("kid-1", priv)))

        cache = JwksCache(JWKS_URL)
        assert await cache.get_signing_key("no-such-kid") is None

    @respx.mock
    async def test_unknown_kid_refetch_is_bounded_while_fresh(self):
        priv = Ed25519PrivateKey.generate()
        route = respx.get(JWKS_URL).mock(return_value=Response(200, json=_jwks("kid-1", priv)))

        # Fresh cache + long refetch cooldown: an unknown kid must not force a refetch.
        cache = JwksCache(JWKS_URL, ttl_seconds=300, min_refetch_interval_seconds=300)
        await cache.get_signing_key("kid-1")  # loads (call 1)
        await cache.get_signing_key("unknown")
        await cache.get_signing_key("unknown")

        assert route.call_count == 1

    @respx.mock
    async def test_http_error_fails_closed(self):
        respx.get(JWKS_URL).mock(return_value=Response(503))

        cache = JwksCache(JWKS_URL)
        with pytest.raises(JwksUnavailableError):
            await cache.get_signing_key("kid-1")

    @respx.mock
    async def test_network_error_fails_closed(self):
        respx.get(JWKS_URL).mock(side_effect=httpx.ConnectError("boom"))

        cache = JwksCache(JWKS_URL)
        with pytest.raises(JwksUnavailableError):
            await cache.get_signing_key("kid-1")

    @respx.mock
    async def test_malformed_body_fails_closed(self):
        """A 200 whose JSON parses but is not a valid JWKS raises PyJWKSetError
        inside PyJWKSet.from_dict; it must fail closed as JwksUnavailableError
        (-> 503 upstream), not escape as an uncaught 500."""
        respx.get(JWKS_URL).mock(return_value=Response(200, json={"not": "a jwks"}))

        cache = JwksCache(JWKS_URL)
        with pytest.raises(JwksUnavailableError):
            await cache.get_signing_key("kid-1")

    @respx.mock
    async def test_unknown_kid_refetch_allowed_after_interval(self):
        """A zero refetch cooldown lets an unknown kid trigger one refetch, which
        picks up a rotated-in key (kid-2) added after the first load."""
        priv = Ed25519PrivateKey.generate()
        route = respx.get(JWKS_URL).mock(return_value=Response(200, json=_jwks("kid-1", priv)))

        cache = JwksCache(JWKS_URL, min_refetch_interval_seconds=0)
        assert await cache.get_signing_key("kid-1") is not None  # loads (call 1)

        # Rotation: the endpoint now serves kid-2. A fresh cache misses it, but the
        # zero cooldown permits the unknown-kid refetch that discovers it.
        route.mock(return_value=Response(200, json=_jwks("kid-2", priv)))
        assert await cache.get_signing_key("kid-2") is not None
        assert route.call_count == 2
