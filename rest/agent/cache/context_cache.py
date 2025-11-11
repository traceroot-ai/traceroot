"""Context caching system for TraceRoot agent framework."""

import hashlib
import json
from dataclasses import dataclass
from datetime import datetime, timezone
from enum import Enum
from typing import Any, Dict, List, Optional, Tuple

from rest.agent.context.tree import SpanNode
from rest.agent.typing import LogFeature, SpanFeature


class CacheStrategy(Enum):
    """Cache invalidation strategies."""

    NONE = "none"  # No caching
    FULL = "full"  # Full cache invalidation on any change
    APPEND_ONLY = "append_only"  # Append-only when possible


@dataclass
class ContextCacheEntry:
    """A single entry in the context cache."""

    cache_key: str
    context_data: str
    log_features: List[LogFeature]
    span_features: List[SpanFeature]
    tree_hash: str
    trace_id: str
    created_at: datetime
    last_accessed: datetime
    access_count: int = 0
    chunk_count: int = 0
    estimated_tokens: int = 0


@dataclass
class ContextCacheConfig:
    """Configuration for context caching."""

    enabled: bool = True
    strategy: CacheStrategy = CacheStrategy.APPEND_ONLY
    max_cache_size: int = 100  # Maximum number of cache entries
    max_context_size: int = 1_000_000  # Maximum context size in characters
    ttl_seconds: int = 3600  # Time to live in seconds
    enable_append_only: bool = True
    hash_algorithm: str = "sha256"


class ContextCache:
    """Context cache implementation with append-only optimization."""

    def __init__(self, config: Optional[ContextCacheConfig] = None):
        self.config = config or ContextCacheConfig()
        self._cache: Dict[str, ContextCacheEntry] = {}
        self._access_order: List[str] = []  # For LRU eviction

    def _generate_cache_key(
        self,
        trace_id: str,
        log_features: List[LogFeature],
        span_features: List[SpanFeature],
        tree_hash: str,
        user_message: str,
        chat_history_hash: Optional[str] = None,
    ) -> str:
        """Generate a cache key based on input parameters."""
        key_data = {
            "trace_id": trace_id,
            "log_features": [f.value for f in log_features],
            "span_features": [f.value for f in span_features],
            "tree_hash": tree_hash,
            "user_message": user_message,
            "chat_history_hash": chat_history_hash or "",
        }

        key_string = json.dumps(key_data, sort_keys=True)
        return hashlib.sha256(key_string.encode()).hexdigest()[:16]

    def _generate_tree_hash(self, tree: SpanNode) -> str:
        """Generate a hash for the tree structure to detect changes."""
        # Create a simplified representation of the tree for hashing
        tree_data = {
            "span_id": tree.span_id,
            "func_full_name": tree.func_full_name,
            "span_latency": tree.span_latency,
            "span_utc_start_time": tree.span_utc_start_time.isoformat(),
            "span_utc_end_time": tree.span_utc_end_time.isoformat(),
            "logs_count": len(tree.logs),
            "children_count": len(tree.children_spans),
        }

        # Add child span IDs for structure validation
        child_span_ids = [child.span_id for child in tree.children_spans]
        tree_data["child_span_ids"] = sorted(child_span_ids)

        tree_string = json.dumps(tree_data, sort_keys=True)
        return hashlib.sha256(tree_string.encode()).hexdigest()[:16]

    def _generate_chat_history_hash(
        self,
        chat_history: Optional[List[Dict[str,
                                         Any]]]
    ) -> str:
        """Generate a hash for chat history to detect changes."""
        if not chat_history:
            return ""

        # Only hash the last 10 records as that's what's used in the system
        recent_history = chat_history[-10:] if len(chat_history) > 10 else chat_history

        history_data = []
        for record in recent_history:
            # Only include relevant fields for hashing
            history_data.append(
                {
                    "role": record.get("role"),
                    "content": record.get("content") or record.get("user_message",
                                                                   ""),
                }
            )

        history_string = json.dumps(history_data, sort_keys=True)
        return hashlib.sha256(history_string.encode()).hexdigest()[:16]

    def _is_context_superset(
        self,
        existing_context: str,
        new_context: str,
        existing_features: Tuple[List[LogFeature],
                                 List[SpanFeature]],
        new_features: Tuple[List[LogFeature],
                            List[SpanFeature]],
    ) -> bool:
        """Check if new context is a strict superset of existing context."""
        existing_log_features, existing_span_features = existing_features
        new_log_features, new_span_features = new_features

        if not (
            set(existing_log_features).issubset(set(new_log_features))
            and set(existing_span_features).issubset(set(new_span_features))
        ):
            return False

        return existing_context in new_context

    def _evict_lru(self):
        """Evict least recently used cache entry."""
        if not self._access_order:
            return

        lru_key = self._access_order.pop(0)
        if lru_key in self._cache:
            del self._cache[lru_key]

    def _update_access_order(self, cache_key: str):
        """Update access order for LRU eviction."""
        if cache_key in self._access_order:
            self._access_order.remove(cache_key)
        self._access_order.append(cache_key)

    def get_cached_context(
        self,
        trace_id: str,
        tree: SpanNode,
        log_features: List[LogFeature],
        span_features: List[SpanFeature],
        user_message: str,
        chat_history: Optional[List[Dict[str,
                                         Any]]] = None,
    ) -> Optional[Tuple[str,
                        List[str],
                        int]]:
        """
        Get cached context if available and valid.

        Returns:
            Tuple of (context_data, context_chunks, estimated_tokens) or None
        """
        if not self.config.enabled:
            return None

        tree_hash = self._generate_tree_hash(tree)
        chat_history_hash = self._generate_chat_history_hash(chat_history)

        cache_key = self._generate_cache_key(
            trace_id,
            log_features,
            span_features,
            tree_hash,
            user_message,
            chat_history_hash
        )

        if cache_key not in self._cache:
            return None

        entry = self._cache[cache_key]

        # Check TTL
        now = datetime.now(timezone.utc)
        if (now - entry.created_at).total_seconds() > self.config.ttl_seconds:
            del self._cache[cache_key]
            if cache_key in self._access_order:
                self._access_order.remove(cache_key)
            return None

        # Update access tracking
        entry.last_accessed = now
        entry.access_count += 1
        self._update_access_order(cache_key)

        # Return cached data
        context_chunks = self._chunk_context(entry.context_data)
        return entry.context_data, context_chunks, entry.estimated_tokens

    def cache_context(
        self,
        trace_id: str,
        tree: SpanNode,
        log_features: List[LogFeature],
        span_features: List[SpanFeature],
        user_message: str,
        context_data: str,
        chat_history: Optional[List[Dict[str,
                                         Any]]] = None,
    ) -> str:
        """
        Cache context data with append-only optimization when possible.

        Returns:
            The cache key for the stored entry
        """
        if not self.config.enabled:
            return ""

        tree_hash = self._generate_tree_hash(tree)
        chat_history_hash = self._generate_chat_history_hash(chat_history)

        cache_key = self._generate_cache_key(
            trace_id,
            log_features,
            span_features,
            tree_hash,
            user_message,
            chat_history_hash
        )

        if (
            self.config.strategy == CacheStrategy.APPEND_ONLY
            and self.config.enable_append_only
        ):

            for existing_key, existing_entry in self._cache.items():
                if (
                    existing_entry.tree_hash == tree_hash
                    and existing_entry.trace_id == trace_id
                ):

                    if self._is_context_superset(
                        existing_entry.context_data,
                        context_data,
                        (existing_entry.log_features,
                         existing_entry.span_features),
                        (log_features,
                         span_features),
                    ):
                        if len(context_data) > len(existing_entry.context_data):
                            delta = context_data[len(existing_entry.context_data):]
                            existing_entry.context_data += delta
                            existing_entry.estimated_tokens = len(
                                existing_entry.context_data
                            ) * 4
                            existing_entry.chunk_count = len(
                                self._chunk_context(existing_entry.context_data)
                            )
                            existing_entry.last_accessed = datetime.now(timezone.utc)
                            self._update_access_order(existing_key)
                            return existing_key

        # Create new cache entry
        estimated_tokens = len(context_data) * 4
        context_chunks = self._chunk_context(context_data)

        entry = ContextCacheEntry(
            cache_key=cache_key,
            context_data=context_data,
            log_features=log_features,
            span_features=span_features,
            tree_hash=tree_hash,
            trace_id=trace_id,
            created_at=datetime.now(timezone.utc),
            last_accessed=datetime.now(timezone.utc),
            chunk_count=len(context_chunks),
            estimated_tokens=estimated_tokens,
        )

        if len(self._cache) >= self.config.max_cache_size:
            self._evict_lru()

        self._cache[cache_key] = entry
        self._update_access_order(cache_key)

        return cache_key

    def _chunk_context(self, context: str) -> List[str]:
        """Chunk context using the same logic as the main system."""
        from rest.agent.chunk.sequential import sequential_chunk

        context_chunks = list(sequential_chunk(context))
        if len(context_chunks) == 1:
            return [
                f"\n\nHere is the structure of the tree with related "
                "information:\n\n"
                f"{context}"
            ]

        messages = []
        for i, chunk in enumerate(context_chunks):
            messages.append(
                f"\n\nHere is the structure of the tree "
                f"with related information of the "
                f"{i + 1}th chunk of the tree:\n\n"
                f"{chunk}"
            )
        return messages

    def invalidate_cache(self, trace_id: Optional[str] = None):
        """Invalidate cache entries, optionally filtered by trace_id."""
        if trace_id:
            keys_to_remove = [
                key for key, entry in self._cache.items() if entry.trace_id == trace_id
            ]
            for key in keys_to_remove:
                del self._cache[key]
                if key in self._access_order:
                    self._access_order.remove(key)
        else:
            self._cache.clear()
            self._access_order.clear()

    def get_cache_stats(self) -> Dict[str, Any]:
        """Get cache statistics for monitoring."""
        if not self._cache:
            return {
                "total_entries": 0,
                "total_tokens": 0,
                "average_tokens_per_entry": 0,
                "hit_rate": 0.0,
            }

        total_tokens = sum(entry.estimated_tokens for entry in self._cache.values())
        total_accesses = sum(entry.access_count for entry in self._cache.values())

        return {
            "total_entries": len(self._cache),
            "total_tokens": total_tokens,
            "average_tokens_per_entry": total_tokens / len(self._cache),
            "total_accesses": total_accesses,
            "hit_rate": total_accesses / len(self._cache) if self._cache else 0.0,
            "strategy": self.config.strategy.value,
            "enabled": self.config.enabled,
        }
