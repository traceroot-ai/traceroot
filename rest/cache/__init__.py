"""Cache module for REST API.

This module provides a type-based cache system with support for different
backends (memory, Redis, etc.) for different data types (trace, log, github, etc.).

Example usage:
    from rest.cache import Cache, CacheType

    cache = Cache()
    await cache[CacheType.TRACE].get(key)
    await cache[CacheType.TRACE].set(key, value)
    await cache[CacheType.LOG].get(key)
    await cache[CacheType.GITHUB].set(key, value)
"""

from .manager import Cache
from .types import CacheType

__all__ = ["Cache", "CacheType"]
