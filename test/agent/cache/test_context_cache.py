"""
Unit tests for context caching system.

Tests cache hits, misses, invalidation, and append-only updates
following the principles from the Manus blog.
"""

import json
import pytest
from datetime import datetime, timezone, timedelta
from unittest.mock import Mock, patch

from rest.agent.cache.context_cache import (
    ContextCache, 
    ContextCacheConfig, 
    CacheStrategy,
    ContextCacheEntry
)
from rest.agent.cache.manager import ContextCacheManager
from rest.agent.context.tree import SpanNode, LogNode
from rest.agent.typing import LogFeature, SpanFeature


@pytest.fixture
def sample_span_node():
    """Create a sample SpanNode for testing."""
    return SpanNode(
        span_id="test_span_1",
        func_full_name="test_function",
        span_latency=0.1,
        span_utc_start_time=datetime.now(timezone.utc),
        span_utc_end_time=datetime.now(timezone.utc),
        logs=[
            LogNode(
                log_utc_timestamp=datetime.now(timezone.utc),
                log_level="INFO",
                log_file_name="test.py",
                log_func_name="test_function",
                log_message="Test log message",
                log_line_number=10,
                log_source_code_line="print('test')",
                log_source_code_lines_above=["def test_function():"],
                log_source_code_lines_below=["    return True"]
            )
        ],
        children_spans=[]
    )


@pytest.fixture
def cache_config():
    """Create a test cache configuration."""
    return ContextCacheConfig(
        enabled=True,
        strategy=CacheStrategy.APPEND_ONLY,
        max_cache_size=10,
        ttl_seconds=3600,
        enable_append_only=True
    )


@pytest.fixture
def context_cache(cache_config):
    """Create a context cache instance for testing."""
    return ContextCache(cache_config)


@pytest.fixture
def cache_manager(cache_config):
    """Create a cache manager instance for testing."""
    return ContextCacheManager(cache_config)


class TestContextCache:
    """Test the core ContextCache functionality."""

    def test_cache_key_generation(self, context_cache, sample_span_node):
        """Test cache key generation is deterministic."""
        trace_id = "test_trace"
        log_features = [LogFeature.LOG_LEVEL, LogFeature.LOG_MESSAGE_VALUE]
        span_features = [SpanFeature.SPAN_LATENCY]
        user_message = "test message"
        
        key1 = context_cache._generate_cache_key(
            trace_id, log_features, span_features, "tree_hash", user_message
        )
        key2 = context_cache._generate_cache_key(
            trace_id, log_features, span_features, "tree_hash", user_message
        )
        
        assert key1 == key2
        assert len(key1) == 16  # Should be truncated to 16 chars

    def test_tree_hash_generation(self, context_cache, sample_span_node):
        """Test tree hash generation for change detection."""
        hash1 = context_cache._generate_tree_hash(sample_span_node)
        hash2 = context_cache._generate_tree_hash(sample_span_node)
        
        assert hash1 == hash2
        assert len(hash1) == 16

    def test_cache_miss_then_hit(self, context_cache, sample_span_node):
        """Test cache miss followed by cache hit."""
        trace_id = "test_trace"
        log_features = [LogFeature.LOG_LEVEL]
        span_features = [SpanFeature.SPAN_LATENCY]
        user_message = "test message"
        
        # First call should be a miss
        result = context_cache.get_cached_context(
            trace_id, sample_span_node, log_features, span_features, user_message
        )
        assert result is None
        
        # Cache the context
        context_data = json.dumps(sample_span_node.to_dict(span_features, log_features), indent=4)
        cache_key = context_cache.cache_context(
            trace_id, sample_span_node, log_features, span_features, user_message, context_data
        )
        assert cache_key != ""
        
        # Second call should be a hit
        result = context_cache.get_cached_context(
            trace_id, sample_span_node, log_features, span_features, user_message
        )
        assert result is not None
        assert result[0] == context_data  # context_data
        assert len(result[1]) > 0  # context_chunks
        assert result[2] > 0  # estimated_tokens

    def test_cache_ttl_expiration(self, context_cache, sample_span_node):
        """Test cache TTL expiration."""
        # Create config with very short TTL
        short_ttl_config = ContextCacheConfig(
            enabled=True,
            strategy=CacheStrategy.APPEND_ONLY,
            max_cache_size=10,
            ttl_seconds=0,  # Immediate expiration
            enable_append_only=True
        )
        short_ttl_cache = ContextCache(short_ttl_config)
        
        trace_id = "test_trace"
        log_features = [LogFeature.LOG_LEVEL]
        span_features = [SpanFeature.SPAN_LATENCY]
        user_message = "test message"
        
        # Cache the context
        context_data = json.dumps(sample_span_node.to_dict(span_features, log_features), indent=4)
        short_ttl_cache.cache_context(
            trace_id, sample_span_node, log_features, span_features, user_message, context_data
        )
        
        # Manually expire the entry by setting created_at to past
        cache_key = short_ttl_cache._generate_cache_key(
            trace_id, log_features, span_features, 
            short_ttl_cache._generate_tree_hash(sample_span_node), user_message
        )
        if cache_key in short_ttl_cache._cache:
            short_ttl_cache._cache[cache_key].created_at = datetime.now(timezone.utc) - timedelta(seconds=1)
        
        # Should be expired now
        result = short_ttl_cache.get_cached_context(
            trace_id, sample_span_node, log_features, span_features, user_message
        )
        assert result is None

    def test_lru_eviction(self, context_cache, sample_span_node):
        """Test LRU eviction when cache is full."""
        # Create config with very small cache size
        small_cache_config = ContextCacheConfig(
            enabled=True,
            strategy=CacheStrategy.APPEND_ONLY,
            max_cache_size=2,  # Very small cache
            ttl_seconds=3600,
            enable_append_only=True
        )
        small_cache = ContextCache(small_cache_config)
        
        log_features = [LogFeature.LOG_LEVEL]
        span_features = [SpanFeature.SPAN_LATENCY]
        context_data = json.dumps(sample_span_node.to_dict(span_features, log_features), indent=4)
        
        # Fill cache to capacity
        small_cache.cache_context("trace1", sample_span_node, log_features, span_features, "msg1", context_data)
        small_cache.cache_context("trace2", sample_span_node, log_features, span_features, "msg2", context_data)
        
        # Add one more - should evict the first
        small_cache.cache_context("trace3", sample_span_node, log_features, span_features, "msg3", context_data)
        
        # First should be evicted
        result1 = small_cache.get_cached_context("trace1", sample_span_node, log_features, span_features, "msg1")
        assert result1 is None
        
        # Second and third should still be there
        result2 = small_cache.get_cached_context("trace2", sample_span_node, log_features, span_features, "msg2")
        result3 = small_cache.get_cached_context("trace3", sample_span_node, log_features, span_features, "msg3")
        assert result2 is not None
        assert result3 is not None

    def test_append_only_superset_detection(self, context_cache, sample_span_node):
        """Test append-only superset detection."""
        trace_id = "test_trace"
        log_features = [LogFeature.LOG_LEVEL]
        span_features = [SpanFeature.SPAN_LATENCY]
        user_message = "test message"
        
        # Cache with base context
        base_context = json.dumps(
            sample_span_node.to_dict(span_features, log_features), indent=4
        )
        cache_key1 = context_cache.cache_context(
            trace_id, sample_span_node, log_features, span_features, user_message, base_context
        )
        
        # Create a context that is a superset (contains the base context plus more)
        extended_context = base_context + "\n\nAdditional context data for testing append-only behavior."
        
        # Try to cache with extended context (superset) - same features
        cache_key2 = context_cache.cache_context(
            trace_id, sample_span_node, log_features, span_features, user_message, extended_context
        )
        
        # Should reuse the same cache key for append-only update
        assert cache_key1 == cache_key2
        
        # Verify the cached context was updated with extended content
        entry = context_cache._cache[cache_key1]
        assert "Additional context data" in entry.context_data
        assert base_context in entry.context_data

    def test_cache_invalidation(self, context_cache, sample_span_node):
        """Test cache invalidation."""
        trace_id = "test_trace"
        log_features = [LogFeature.LOG_LEVEL]
        span_features = [SpanFeature.SPAN_LATENCY]
        user_message = "test message"
        
        # Cache some data
        context_data = json.dumps(sample_span_node.to_dict(span_features, log_features), indent=4)
        context_cache.cache_context(
            trace_id, sample_span_node, log_features, span_features, user_message, context_data
        )
        
        # Verify it's cached
        result = context_cache.get_cached_context(
            trace_id, sample_span_node, log_features, span_features, user_message
        )
        assert result is not None
        
        # Invalidate specific trace
        context_cache.invalidate_cache(trace_id)
        
        # Should be gone
        result = context_cache.get_cached_context(
            trace_id, sample_span_node, log_features, span_features, user_message
        )
        assert result is None

    def test_cache_statistics(self, context_cache, sample_span_node):
        """Test cache statistics collection."""
        trace_id = "test_trace"
        log_features = [LogFeature.LOG_LEVEL]
        span_features = [SpanFeature.SPAN_LATENCY]
        user_message = "test message"
        
        # Initially empty
        stats = context_cache.get_cache_stats()
        assert stats["total_entries"] == 0
        
        # Cache some data
        context_data = json.dumps(sample_span_node.to_dict(span_features, log_features), indent=4)
        context_cache.cache_context(
            trace_id, sample_span_node, log_features, span_features, user_message, context_data
        )
        
        # Access it multiple times
        context_cache.get_cached_context(trace_id, sample_span_node, log_features, span_features, user_message)
        context_cache.get_cached_context(trace_id, sample_span_node, log_features, span_features, user_message)
        
        # Check stats
        stats = context_cache.get_cache_stats()
        assert stats["total_entries"] == 1
        assert stats["total_accesses"] >= 2
        assert stats["total_tokens"] > 0


class TestContextCacheManager:
    """Test the ContextCacheManager functionality."""

    def test_get_or_build_context_cache_miss(self, cache_manager, sample_span_node):
        """Test get_or_build_context on cache miss."""
        trace_id = "test_trace"
        log_features = [LogFeature.LOG_LEVEL]
        span_features = [SpanFeature.SPAN_LATENCY]
        user_message = "test message"
        
        context, chunks, tokens, was_cached = cache_manager.get_or_build_context(
            trace_id, sample_span_node, log_features, span_features, user_message
        )
        
        assert context is not None
        assert len(chunks) > 0
        assert tokens > 0
        assert was_cached is False

    def test_get_or_build_context_cache_hit(self, cache_manager, sample_span_node):
        """Test get_or_build_context on cache hit."""
        trace_id = "test_trace"
        log_features = [LogFeature.LOG_LEVEL]
        span_features = [SpanFeature.SPAN_LATENCY]
        user_message = "test message"
        
        # First call - cache miss
        context1, chunks1, tokens1, was_cached1 = cache_manager.get_or_build_context(
            trace_id, sample_span_node, log_features, span_features, user_message
        )
        assert was_cached1 is False
        
        # Second call - cache hit
        context2, chunks2, tokens2, was_cached2 = cache_manager.get_or_build_context(
            trace_id, sample_span_node, log_features, span_features, user_message
        )
        assert was_cached2 is True
        assert context1 == context2
        assert tokens1 == tokens2

    def test_force_rebuild(self, cache_manager, sample_span_node):
        """Test force rebuild bypasses cache."""
        trace_id = "test_trace"
        log_features = [LogFeature.LOG_LEVEL]
        span_features = [SpanFeature.SPAN_LATENCY]
        user_message = "test message"
        
        # Cache some data
        cache_manager.get_or_build_context(
            trace_id, sample_span_node, log_features, span_features, user_message
        )
        
        # Force rebuild
        context, chunks, tokens, was_cached = cache_manager.get_or_build_context(
            trace_id, sample_span_node, log_features, span_features, user_message, force_rebuild=True
        )
        
        assert was_cached is False

    def test_cache_statistics(self, cache_manager, sample_span_node):
        """Test cache manager statistics."""
        trace_id = "test_trace"
        log_features = [LogFeature.LOG_LEVEL]
        span_features = [SpanFeature.SPAN_LATENCY]
        user_message = "test message"
        
        # Make some requests
        cache_manager.get_or_build_context(trace_id, sample_span_node, log_features, span_features, user_message)
        cache_manager.get_or_build_context(trace_id, sample_span_node, log_features, span_features, user_message)
        
        stats = cache_manager.get_cache_statistics()
        assert stats["cache_hits"] >= 1
        assert stats["cache_misses"] >= 1
        assert stats["total_requests"] >= 2
        assert stats["calculated_hit_rate"] > 0

    def test_cache_health_check(self, cache_manager):
        """Test cache health check."""
        assert cache_manager.is_cache_healthy() is True
        
        # Test with broken cache
        cache_manager.cache = None
        assert cache_manager.is_cache_healthy() is False

    def test_invalidate_trace_cache(self, cache_manager, sample_span_node):
        """Test trace-specific cache invalidation."""
        trace_id = "test_trace"
        log_features = [LogFeature.LOG_LEVEL]
        span_features = [SpanFeature.SPAN_LATENCY]
        user_message = "test message"
        
        # Cache some data
        cache_manager.get_or_build_context(trace_id, sample_span_node, log_features, span_features, user_message)
        
        # Verify it's cached
        context, chunks, tokens, was_cached = cache_manager.get_or_build_context(
            trace_id, sample_span_node, log_features, span_features, user_message
        )
        assert was_cached is True
        
        # Invalidate trace cache
        cache_manager.invalidate_trace_cache(trace_id)
        
        # Should be a miss now
        context, chunks, tokens, was_cached = cache_manager.get_or_build_context(
            trace_id, sample_span_node, log_features, span_features, user_message
        )
        assert was_cached is False


class TestCacheIntegration:
    """Integration tests for the caching system."""

    def test_agent_integration(self, sample_span_node):
        """Test integration with Agent class."""
        from rest.agent.agent import Agent
        
        agent = Agent()
        assert hasattr(agent, 'cache_manager')
        assert agent.cache_manager is not None

    def test_chat_integration(self, sample_span_node):
        """Test integration with Chat class."""
        from rest.agent.chat import Chat
        
        chat = Chat()
        assert hasattr(chat, 'cache_manager')
        assert chat.cache_manager is not None

    def test_configuration_environment_variables(self):
        """Test configuration from environment variables."""
        import os
        from rest.agent.cache.config import get_cache_config, is_caching_enabled
        
        # Test default values
        config = get_cache_config()
        assert config.enabled is True
        assert config.strategy == CacheStrategy.APPEND_ONLY
        
        # Test environment variable override
        with patch.dict(os.environ, {'TRACEROOT_CACHE_ENABLED': 'false'}):
            config = get_cache_config()
            assert config.enabled is False
        
        with patch.dict(os.environ, {'TRACEROOT_CACHE_STRATEGY': 'full'}):
            config = get_cache_config()
            assert config.strategy == CacheStrategy.FULL
