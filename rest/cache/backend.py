"""Cache backend implementations."""

from abc import ABC, abstractmethod
from typing import Any

from aiocache import SimpleMemoryCache


class BaseBackend(ABC):
    """Abstract base class for cache backends."""

    @abstractmethod
    async def get(self, key: Any) -> Any:
        """Get value from cache.

        Args:
            key: Cache key (can be any hashable type)

        Returns:
            Cached value or None if not found
        """

    @abstractmethod
    async def set(self, key: Any, value: Any) -> None:
        """Set value in cache.

        Args:
            key: Cache key (can be any hashable type)
            value: Value to cache
        """


class MemoryBackend(BaseBackend):
    """In-memory cache backend using aiocache.SimpleMemoryCache."""

    def __init__(self, ttl: int):
        """Initialize memory cache backend.

        Args:
            ttl: Time-to-live in seconds
        """
        self.cache = SimpleMemoryCache(ttl=ttl)

    async def get(self, key: Any) -> Any:
        """Get value from cache.

        Args:
            key: Cache key (can be any hashable type)

        Returns:
            Cached value or None if not found
        """
        return await self.cache.get(key)

    async def set(self, key: Any, value: Any) -> None:
        """Set value in cache.

        Args:
            key: Cache key (can be any hashable type)
            value: Value to cache
        """
        await self.cache.set(key, value)
