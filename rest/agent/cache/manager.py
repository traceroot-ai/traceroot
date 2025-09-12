"""Context cache manager for TraceRoot agent framework."""

from typing import Any, Dict, List, Optional, Tuple

from rest.agent.context.tree import SpanNode
from rest.agent.typing import LogFeature, SpanFeature
from .context_cache import ContextCache, ContextCacheConfig
from .config import get_cache_config


class ContextCacheManager:
    """High-level manager for context caching operations."""

    def __init__(self, config: Optional[ContextCacheConfig] = None):
        self.config = config or get_cache_config()
        self.cache = ContextCache(self.config)
        self._cache_hits = 0
        self._cache_misses = 0
        self._append_only_updates = 0

    def get_or_build_context(
        self,
        trace_id: str,
        tree: SpanNode,
        log_features: List[LogFeature],
        span_features: List[SpanFeature],
        user_message: str,
        chat_history: Optional[List[Dict[str, Any]]] = None,
        force_rebuild: bool = False,
    ) -> Tuple[str, List[str], int, bool]:
        """
        Get cached context or build new context.

        Args:
            trace_id: Unique identifier for the trace
            tree: The span tree to process
            log_features: Selected log features
            span_features: Selected span features
            user_message: Current user message
            chat_history: Previous chat history
            force_rebuild: Force rebuild even if cache exists

        Returns:
            Tuple of (context_data, context_chunks, estimated_tokens, was_cached)
        """
        if not self.config.enabled or force_rebuild:
            return self._build_and_cache_context(
                trace_id, tree, log_features, span_features, user_message, chat_history
            )

        # Try to get from cache
        cached_result = self.cache.get_cached_context(
            trace_id, tree, log_features, span_features, user_message, chat_history
        )

        if cached_result is not None:
            self._cache_hits += 1
            return (*cached_result, True)

        # Cache miss - build and cache
        self._cache_misses += 1
        return self._build_and_cache_context(
            trace_id, tree, log_features, span_features, user_message, chat_history
        )

    def _build_and_cache_context(
        self,
        trace_id: str,
        tree: SpanNode,
        log_features: List[LogFeature],
        span_features: List[SpanFeature],
        user_message: str,
        chat_history: Optional[List[Dict[str, Any]]] = None,
    ) -> Tuple[str, List[str], int, bool]:
        """Build context and cache it."""
        import json

        tree_dict = tree.to_dict(log_features=log_features, span_features=span_features)

        context_data = json.dumps(tree_dict, indent=4)

        self.cache.cache_context(
            trace_id, tree, log_features, span_features, user_message, context_data, chat_history
        )

        context_chunks = self.cache._chunk_context(context_data)
        estimated_tokens = len(context_data) * 4

        return context_data, context_chunks, estimated_tokens, False

    def invalidate_trace_cache(self, trace_id: str):
        """Invalidate all cache entries for a specific trace."""
        self.cache.invalidate_cache(trace_id)

    def clear_all_cache(self):
        """Clear all cached contexts."""
        self.cache.invalidate_cache()
        self._cache_hits = 0
        self._cache_misses = 0
        self._append_only_updates = 0

    def get_cache_statistics(self) -> Dict[str, Any]:
        """Get comprehensive cache statistics."""
        base_stats = self.cache.get_cache_stats()

        total_requests = self._cache_hits + self._cache_misses
        hit_rate = self._cache_hits / total_requests if total_requests > 0 else 0.0

        return {
            **base_stats,
            "cache_hits": self._cache_hits,
            "cache_misses": self._cache_misses,
            "total_requests": total_requests,
            "calculated_hit_rate": hit_rate,
            "append_only_updates": self._append_only_updates,
            "config": {
                "enabled": self.config.enabled,
                "strategy": self.config.strategy.value,
                "max_cache_size": self.config.max_cache_size,
                "ttl_seconds": self.config.ttl_seconds,
                "enable_append_only": self.config.enable_append_only,
            },
        }

    def update_config(self, new_config: ContextCacheConfig):
        """Update cache configuration."""
        self.config = new_config
        self.cache = ContextCache(new_config)

    def is_cache_healthy(self) -> bool:
        """Check if cache is functioning properly."""
        try:
            # Test basic operations
            stats = self.get_cache_statistics()
            return (
                isinstance(stats, dict) and "total_entries" in stats and stats["total_entries"] >= 0
            )
        except Exception:
            return False


# Global cache manager instance
_cache_manager: Optional[ContextCacheManager] = None


def get_cache_manager() -> ContextCacheManager:
    """Get the global cache manager instance."""
    global _cache_manager
    if _cache_manager is None:
        _cache_manager = ContextCacheManager()
    return _cache_manager


def reset_cache_manager():
    """Reset the global cache manager (useful for testing)."""
    global _cache_manager
    _cache_manager = None
