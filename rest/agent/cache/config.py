"""Configuration module for context caching."""

import os
from dataclasses import dataclass
from enum import Enum

from .context_cache import CacheStrategy, ContextCacheConfig


class CacheConfigSource(Enum):
    """Configuration source priority."""

    ENV_VAR = "env_var"
    DEFAULT = "default"


@dataclass
class ContextCacheSettings:
    """Runtime settings for context caching."""

    enabled: bool = True
    strategy: CacheStrategy = CacheStrategy.APPEND_ONLY
    max_cache_size: int = 100
    max_context_size: int = 1_000_000
    ttl_seconds: int = 3600
    enable_append_only: bool = True
    hash_algorithm: str = "sha256"

    @classmethod
    def from_env(cls) -> "ContextCacheSettings":
        """Create settings from environment variables."""
        return cls(
            enabled=os.getenv("TRACEROOT_CACHE_ENABLED", "true").lower() == "true",
            strategy=CacheStrategy(os.getenv("TRACEROOT_CACHE_STRATEGY", "append_only")),
            max_cache_size=int(os.getenv("TRACEROOT_CACHE_MAX_SIZE", "100")),
            max_context_size=int(os.getenv("TRACEROOT_CACHE_MAX_CONTEXT_SIZE", "1000000")),
            ttl_seconds=int(os.getenv("TRACEROOT_CACHE_TTL_SECONDS", "3600")),
            enable_append_only=os.getenv("TRACEROOT_CACHE_APPEND_ONLY", "true").lower() == "true",
            hash_algorithm=os.getenv("TRACEROOT_CACHE_HASH_ALGORITHM", "sha256"),
        )

    def to_cache_config(self) -> ContextCacheConfig:
        """Convert to ContextCacheConfig."""
        return ContextCacheConfig(
            enabled=self.enabled,
            strategy=self.strategy,
            max_cache_size=self.max_cache_size,
            max_context_size=self.max_context_size,
            ttl_seconds=self.ttl_seconds,
            enable_append_only=self.enable_append_only,
            hash_algorithm=self.hash_algorithm,
        )


def get_cache_config() -> ContextCacheConfig:
    """Get cache configuration from environment or defaults."""
    settings = ContextCacheSettings.from_env()
    return settings.to_cache_config()


def is_caching_enabled() -> bool:
    """Check if caching is enabled via environment variables."""
    return os.getenv("TRACEROOT_CACHE_ENABLED", "true").lower() == "true"
