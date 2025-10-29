"""Cache configuration for different cache types."""

from dataclasses import dataclass
from typing import Dict

from .types import CacheType


@dataclass
class CacheConfig:
    """Configuration for a cache backend.

    Attributes:
        ttl_seconds: Time-to-live in seconds for cached items
    """

    ttl_seconds: int = 600  # 10 minutes default


# Default cache configuration for all cache types
# GitHub files have longer TTL (30 min) since content for commit SHAs is immutable
DEFAULT_CACHE_CONFIG: Dict[CacheType, CacheConfig] = {
    CacheType.TRACE: CacheConfig(ttl_seconds=600),  # 10 minutes
    CacheType.LOG: CacheConfig(ttl_seconds=600),  # 10 minutes
    CacheType.GITHUB: CacheConfig(ttl_seconds=1800),  # 30 minutes
    CacheType.AGENT: CacheConfig(ttl_seconds=600),  # 10 minutes
    CacheType.CHAT: CacheConfig(ttl_seconds=600),  # 10 minutes
}
