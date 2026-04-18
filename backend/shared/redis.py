"""Redis client helpers for pub/sub (live trace streaming).

Provides lazy-singleton factories for both sync and async Redis clients,
separate from the Celery broker connection.
"""

import redis
import redis.asyncio

from shared.config import settings

_sync_client: redis.Redis | None = None
_async_client: redis.asyncio.Redis | None = None


def get_redis_client() -> redis.Redis:
    """Get a sync Redis client (for use in Celery workers)."""
    global _sync_client
    if _sync_client is None:
        _sync_client = redis.from_url(settings.redis.url, decode_responses=True)
    return _sync_client


def get_async_redis_client() -> redis.asyncio.Redis:
    """Get an async Redis client (for use in FastAPI SSE endpoints)."""
    global _async_client
    if _async_client is None:
        _async_client = redis.asyncio.from_url(settings.redis.url, decode_responses=True)
    return _async_client
