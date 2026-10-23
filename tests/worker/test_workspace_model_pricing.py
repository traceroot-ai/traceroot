"""Unit tests for workspace custom model pricing (Issue #2692, Part 2).

Verifies:
1. In-memory loading and lookup of workspace custom model prices with TTL caching.
2. Exact name matching, case-insensitive matching, and regex pattern matching.
3. Order of precedence:
   - Supplied cost beats workspace custom pricing.
   - Workspace custom pricing beats built-in standard catalog.
   - Standard catalog beats text estimation.
4. Provenance tracking: spans priced with workspace custom rates record
   `traceroot.cost_source = "custom"`.
5. Trace reader `span_cost_details` computes popup breakdown using workspace custom rates.
"""

from __future__ import annotations

import json
from decimal import Decimal
from unittest.mock import MagicMock, patch

from shared.span_attributes import (
    COST_SOURCE,
    COST_SOURCE_CATALOG,
    COST_SOURCE_CUSTOM,
    COST_SOURCE_ESTIMATED,
    COST_SOURCE_SUPPLIED,
)
from tests.fixtures.otel_payloads import make_attr, make_otel_payload, make_span
from worker.otel_transform import transform_otel_to_clickhouse
from worker.tokens.pricing import (
    _load_workspace_prices,
    _project_workspace_cache,
    _workspace_prices_cache,
    get_model_price_with_source,
    get_workspace_id_for_project,
)


class TestWorkspaceModelPricingLookup:
    """Verifies low-level cache loading, matching, and precedence in pricing.py."""

    def setup_method(self):
        _workspace_prices_cache.clear()
        _project_workspace_cache.clear()

    def teardown_method(self):
        _workspace_prices_cache.clear()
        _project_workspace_cache.clear()

    def test_exact_and_case_insensitive_model_match(self):
        sample_rows = [
            (
                "my-internal-llama",
                None,
                Decimal("0.000002"),  # input
                Decimal("0.000006"),  # output
                Decimal("0.0000005"),  # cacheRead
                Decimal("0.000002"),  # cacheWrite
            )
        ]

        with patch("psycopg2.connect") as mock_connect:
            mock_cursor = MagicMock()
            mock_cursor.fetchall.return_value = sample_rows
            mock_connect.return_value.cursor.return_value.__enter__.return_value = mock_cursor

            # Exact match
            prices, source = get_model_price_with_source("my-internal-llama", workspace_id="ws_1")
            assert source == COST_SOURCE_CUSTOM
            assert prices == {
                "input": 0.000002,
                "output": 0.000006,
                "cacheRead": 0.0000005,
                "cacheWrite": 0.000002,
            }

            # Case-insensitive match
            prices_upper, source_upper = get_model_price_with_source(
                "MY-INTERNAL-LLAMA", workspace_id="ws_1"
            )
            assert source_upper == COST_SOURCE_CUSTOM
            assert prices_upper == prices

    def test_regex_pattern_match(self):
        sample_rows = [
            (
                "custom-mistral",
                r"(?i)^(custom\/)?mistral-large(-v\d+)?$",
                Decimal("0.000003"),
                Decimal("0.000009"),
                None,
                None,
            )
        ]

        with patch("psycopg2.connect") as mock_connect:
            mock_cursor = MagicMock()
            mock_cursor.fetchall.return_value = sample_rows
            mock_connect.return_value.cursor.return_value.__enter__.return_value = mock_cursor

            prices, source = get_model_price_with_source(
                "custom/mistral-large-v2", workspace_id="ws_1"
            )
            assert source == COST_SOURCE_CUSTOM
            assert prices["input"] == 0.000003
            assert prices["output"] == 0.000009

    def test_custom_pricing_overrides_catalog(self):
        """When a workspace registers custom pricing for a catalog model (e.g. enterprise discount),
        the workspace custom price must take precedence over catalog rates."""
        custom_rows = [
            (
                "gpt-4o",
                None,
                Decimal("0.000001"),  # custom discounted rate
                Decimal("0.000004"),
                None,
                None,
            )
        ]

        catalog_prices = {"input": 0.000005, "output": 0.000015}

        with (
            patch("psycopg2.connect") as mock_connect,
            patch("worker.tokens.pricing._get_catalog_price", return_value=catalog_prices),
        ):
            mock_cursor = MagicMock()
            mock_cursor.fetchall.return_value = custom_rows
            mock_connect.return_value.cursor.return_value.__enter__.return_value = mock_cursor

            # In workspace with custom price: custom wins
            prices, source = get_model_price_with_source("gpt-4o", workspace_id="ws_1")
            assert source == COST_SOURCE_CUSTOM
            assert prices["input"] == 0.000001

            # In another workspace without custom price: catalog wins
            mock_cursor.fetchall.return_value = []
            prices_other, source_other = get_model_price_with_source(
                "gpt-4o", workspace_id="ws_other"
            )
            assert source_other == COST_SOURCE_CATALOG
            assert prices_other["input"] == 0.000005

    def test_cache_ttl_and_refresh(self):
        """Pricing cache expires after TTL and reloads without worker restart (#1096)."""
        first_row = [("model-a", None, Decimal("0.000001"), Decimal("0.000002"), None, None)]
        updated_row = [("model-a", None, Decimal("0.000005"), Decimal("0.000010"), None, None)]

        with patch("psycopg2.connect") as mock_connect:
            mock_cursor = MagicMock()
            mock_cursor.fetchall.return_value = first_row
            mock_connect.return_value.cursor.return_value.__enter__.return_value = mock_cursor

            # Initial load
            p1 = _load_workspace_prices("ws_1")
            assert p1[0]["prices"]["input"] == 0.000001

            # Second call within TTL returns cached without querying DB again
            mock_cursor.fetchall.return_value = updated_row
            p2 = _load_workspace_prices("ws_1")
            assert p2[0]["prices"]["input"] == 0.000001

            # After TTL expires: reloads updated rates
            with patch("time.monotonic", return_value=1e12):
                p3 = _load_workspace_prices("ws_1")
                assert p3[0]["prices"]["input"] == 0.000005

    def test_get_workspace_id_for_project_caching(self):
        """Project to workspace mapping is cached in-memory."""
        with patch("psycopg2.connect") as mock_connect:
            mock_cursor = MagicMock()
            mock_cursor.fetchone.return_value = ("ws_123",)
            mock_connect.return_value.cursor.return_value.__enter__.return_value = mock_cursor

            wid = get_workspace_id_for_project("proj_abc")
            assert wid == "ws_123"

            # Re-read from cache
            mock_cursor.fetchone.return_value = ("ws_different",)
            wid2 = get_workspace_id_for_project("proj_abc")
            assert wid2 == "ws_123"

    def test_redos_pattern_safety(self):
        """Pathological regex pattern does not freeze or crash worker."""
        from worker.tokens.pricing import _match_pattern

        # Catastrophic backtracking pattern: ^(a+)+$
        catastrophic_pattern = "^(a+)+$"
        near_match = "a" * 30 + "!"
        # Should cleanly return False without hanging
        assert _match_pattern(catastrophic_pattern, near_match) is False

    def test_stale_catalog_cache_fallback_on_db_failure(self, monkeypatch):
        """When catalog cache TTL expires and DB re-read fails, stale cache is preserved."""
        from worker.tokens import pricing

        monkeypatch.setattr(
            pricing,
            "_cache",
            [{"model_name": "stale-model", "match_pattern": None, "prices": {"input": 0.001}}],
        )
        monkeypatch.setattr(pricing, "_cache_loaded_at", 100.0)

        with (
            patch("time.monotonic", return_value=1000.0),  # > 300s TTL expired
            patch("psycopg2.connect", side_effect=Exception("Database down")),
        ):
            loaded = pricing._load_cache()
            # Stale cache is returned rather than empty list
            assert loaded == pricing._cache
            # _cache_loaded_at is NOT updated so next call still retries
            assert pricing._cache_loaded_at == 100.0

    def test_stale_project_workspace_mapping_fallback_on_db_failure(self):
        """When project workspace mapping TTL expires and DB re-read fails, stale mapping is returned."""
        _project_workspace_cache["proj-stale"] = (50.0, "ws-stale")

        with (
            patch("time.monotonic", return_value=100.0),
            patch("psycopg2.connect", side_effect=Exception("Database down")),
        ):
            wid = get_workspace_id_for_project("proj-stale")
            assert wid == "ws-stale"

    def test_cache_bounding_and_pruning(self):
        """Caches prune expired entries and enforce maximum bounds."""
        from worker.tokens.pricing import _prune_cache

        test_cache = {f"key_{i}": (500.0, f"val_{i}") for i in range(10)}
        # Add some already expired entries and some fresh entries
        test_cache["expired_1"] = (10.0, "old")
        test_cache["fresh_1"] = (200.0, "new")

        with patch("time.monotonic", return_value=100.0):
            _prune_cache(test_cache, max_size=5)
            # Expired entries are removed
            assert "expired_1" not in test_cache
            # Size is capped at 5
            assert len(test_cache) <= 5


class TestWorkspaceModelPricingIngest:
    """Verifies end-to-end span ingestion with workspace custom pricing."""

    TRACE = "aa" * 16
    SPAN = "bb" * 8

    def setup_method(self):
        _workspace_prices_cache.clear()
        _project_workspace_cache.clear()

    def test_span_prices_with_workspace_custom_model(self):
        """Unpriced model calculates cost and records 'custom' provenance when workspace price exists."""
        custom_prices = {"input": 0.000002, "output": 0.000005}

        span = make_span(self.TRACE, self.SPAN)
        span["attributes"] = [
            make_attr("traceroot.llm.model", "my-fine-tuned-model"),
            make_attr("llm.token_count.prompt", 1000),
            make_attr("llm.token_count.completion", 200),
        ]

        with (
            patch("worker.tokens.pricing.get_workspace_id_for_project", return_value="ws_1"),
            patch(
                "worker.tokens.pricing._load_workspace_prices",
                return_value=[{"model_name": "my-fine-tuned-model", "prices": custom_prices}],
            ),
        ):
            _, spans = transform_otel_to_clickhouse(make_otel_payload([span]), "proj-1")
            transformed = spans[0]

            # 1000 * 0.000002 + 200 * 0.000005 = 0.002 + 0.001 = 0.003
            assert transformed["cost"] == 0.003
            meta = json.loads(transformed["metadata"])
            assert meta.get(COST_SOURCE) == COST_SOURCE_CUSTOM

    def test_supplied_cost_beats_workspace_custom_pricing(self):
        """Caller-supplied dollar cost supersedes workspace custom pricing."""
        custom_prices = {"input": 0.000002, "output": 0.000005}

        span = make_span(self.TRACE, self.SPAN)
        span["attributes"] = [
            make_attr("traceroot.llm.model", "my-fine-tuned-model"),
            make_attr("claude_agent_sdk.total_cost_usd", 0.045),
            make_attr("llm.token_count.prompt", 1000),
            make_attr("llm.token_count.completion", 200),
        ]

        with (
            patch("worker.tokens.pricing.get_workspace_id_for_project", return_value="ws_1"),
            patch(
                "worker.tokens.pricing._load_workspace_prices",
                return_value=[{"model_name": "my-fine-tuned-model", "prices": custom_prices}],
            ),
        ):
            _, spans = transform_otel_to_clickhouse(make_otel_payload([span]), "proj-1")
            transformed = spans[0]

            # Supplied 0.045 wins over computed custom cost 0.003
            assert transformed["cost"] == 0.045
            meta = json.loads(transformed["metadata"])
            assert meta.get(COST_SOURCE) == COST_SOURCE_SUPPLIED

    def test_text_estimation_uses_workspace_custom_pricing(self):
        """Text-estimated spans without reported token counts use workspace custom rates."""
        custom_prices = {"input": 0.000002, "output": 0.000005}

        span = make_span(self.TRACE, self.SPAN)
        span["attributes"] = [
            make_attr("traceroot.llm.model", "custom-chat-model"),
            make_attr("traceroot.span.kind", "llm"),
            make_attr("traceroot.llm.input", "hello world " * 10),
            make_attr("traceroot.llm.output", "response text " * 10),
        ]

        with (
            patch("worker.tokens.pricing.get_workspace_id_for_project", return_value="ws_1"),
            patch(
                "worker.tokens.pricing._load_workspace_prices",
                return_value=[{"model_name": "custom-chat-model", "prices": custom_prices}],
            ),
        ):
            _, spans = transform_otel_to_clickhouse(make_otel_payload([span]), "proj-1")
            transformed = spans[0]

            assert transformed["cost"] is not None
            meta = json.loads(transformed["metadata"])
            assert meta.get(COST_SOURCE) == COST_SOURCE_ESTIMATED


class TestTraceReaderWorkspaceCostDetails:
    """Verifies that trace reader cost_details breaks down custom model prices accurately."""

    def test_span_cost_details_uses_workspace_custom_pricing(self):
        from rest.services.trace_reader import span_cost_details

        custom_prices = {"input": 0.000002, "output": 0.000005}

        with (
            patch("worker.tokens.pricing.get_workspace_id_for_project", return_value="ws_1"),
            patch(
                "worker.tokens.pricing._load_workspace_prices",
                return_value=[{"model_name": "my-custom-model", "prices": custom_prices}],
            ),
        ):
            details = span_cost_details(
                model_name="my-custom-model",
                input_tokens=1000,
                output_tokens=200,
                usage_details={},
                is_supplied_cost=False,
                project_id="proj-1",
            )

            assert details["input_uncached_cost"] == 0.002
            assert details["output_cost"] == 0.001
            assert sum(details.values()) == 0.003
