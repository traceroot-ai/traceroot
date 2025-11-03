"""Cache manager with type-based backend access."""

from typing import Dict, Optional

from .backend import BaseBackend, MemoryBackend
from .config import DEFAULT_CACHE_CONFIG, CacheConfig
from .types import CacheType


class Cache:
    """Cache manager that provides type-based backend access.

    Usage:
        cache = Cache()
        await cache[CacheType.TRACE].get(key)
        await cache[CacheType.TRACE].set(key, value)
        await cache[CacheType.LOG].get(key)
        await cache[CacheType.GITHUB].set(key, value)
    """

    def __init__(self, config: Optional[Dict[CacheType, CacheConfig]] = None):
        """Initialize cache manager.

        Args:
            config: Optional custom configuration dict mapping CacheType to CacheConfig.
                    If not provided, uses DEFAULT_CACHE_CONFIG.
        """
        self.config = config or DEFAULT_CACHE_CONFIG
        self._backends: Dict[CacheType, BaseBackend] = {}
        self._initialize_backends()

    def _initialize_backends(self) -> None:
        """Create memory backend for each cache type based on configuration."""
        for cache_type, cfg in self.config.items():
            # For now, all backends use MemoryBackend
            # In the future, can switch specific types to RedisBackend, etc.
            self._backends[cache_type] = MemoryBackend(ttl=cfg.ttl_seconds)

    def __getitem__(self, cache_type: CacheType) -> BaseBackend:
        """Enable dictionary-style access: cache[CacheType.TRACE].

        Args:
            cache_type: Type of cache to access

        Returns:
            Backend instance for the given cache type

        Raises:
            KeyError: If cache_type is not configured
        """
        return self._backends[cache_type]
