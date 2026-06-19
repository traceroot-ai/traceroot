"""Model pricing and cost calculation.

Prices are loaded from the ``standard_models`` / ``standard_model_prices``
PostgreSQL tables (synced from standard-model-prices.json by the TS services).
The in-memory cache is populated on first call and refreshed on a TTL so that
pricing updates in the DB propagate to long-running workers without a restart
(see issue #1096). The refresh interval is configurable via the
``PRICING_CACHE_TTL_SECONDS`` environment variable (default 300s).
"""

from __future__ import annotations

import logging
import os
import re
import threading
import time
from decimal import Decimal

import psycopg2

from shared.config import settings

from .buckets import TokenBuckets
from .usage import count_tokens

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# In-memory cache (populated on first call, refreshed on a TTL)
# ---------------------------------------------------------------------------

# How long a loaded price cache is served before a refresh is attempted.
# Configurable so deployments can trade freshness against DB load.
_CACHE_TTL_SECONDS: float = float(os.getenv("PRICING_CACHE_TTL_SECONDS", "300"))

_cache: list[dict] | None = None
_cache_loaded_at: float | None = None
_cache_lock = threading.Lock()


def _cache_is_fresh() -> bool:
    """True when a populated cache exists and is still within its TTL window."""
    return (
        _cache is not None
        and _cache_loaded_at is not None
        and (time.monotonic() - _cache_loaded_at) < _CACHE_TTL_SECONDS
    )


def _fetch_prices_from_db() -> list[dict]:
    """Read the price table and group rows by model.

    Returns an empty list when the DB is unavailable, so the caller can decide
    whether to retry or keep serving a previously loaded cache.
    """
    try:
        conn = psycopg2.connect(settings.database_url)
        try:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    SELECT m.model_name, m.match_pattern, p.usage_type, p.price
                    FROM standard_models m
                    JOIN standard_model_prices p ON p.model_id = m.id
                    ORDER BY m.model_name, p.usage_type
                    """
                )
                rows = cur.fetchall()
        finally:
            conn.close()
    except Exception as exc:
        logger.warning(
            "Failed to load model prices from DB — costs will be None until DB is available. Error: %s",
            exc,
        )
        return []

    # Group rows by model_name
    by_model: dict[str, dict] = {}
    for model_name, match_pattern, usage_type, price in rows:
        if model_name not in by_model:
            by_model[model_name] = {
                "model_name": model_name,
                "match_pattern": match_pattern,
                "prices": {},
            }
        by_model[model_name]["prices"][usage_type] = (
            float(price) if isinstance(price, Decimal) else price
        )

    return list(by_model.values())


def _load_cache() -> list[dict]:
    """Return cached model prices, refreshing from the DB once the TTL lapses.

    A fresh cache is served without touching the DB. When the TTL has lapsed,
    one caller refreshes under a lock (others wait, then reuse the result). If
    the refresh fails or returns no rows, any previously loaded prices are kept
    rather than dropping to an empty cache, and the timestamp is left unchanged
    so the next call retries promptly.
    """
    global _cache, _cache_loaded_at

    if _cache_is_fresh():
        return _cache  # type: ignore[return-value]

    with _cache_lock:
        # Another thread may have refreshed while we waited for the lock.
        if _cache_is_fresh():
            return _cache  # type: ignore[return-value]

        models = _fetch_prices_from_db()
        if not models:
            # DB unavailable/empty: keep stale prices if we have them, otherwise
            # return empty and leave the cache unset so the next call retries.
            return _cache if _cache is not None else []

        _cache = models
        _cache_loaded_at = time.monotonic()
        return _cache


# ---------------------------------------------------------------------------
# Public API (unchanged signatures)
# ---------------------------------------------------------------------------


def get_model_price(model: str) -> dict[str, float] | None:
    """Lookup price for model. Tries exact match, then regex fallback.

    Returns dict with keys like ``input``, ``output``, ``cacheRead``, ``cacheWrite``
    (values in USD per token), or None if not found.
    """
    cache = _load_cache()

    # Exact match on model_name
    for entry in cache:
        if entry["model_name"] == model:
            return entry["prices"]

    # Regex fallback using match_pattern
    for entry in cache:
        try:
            if re.search(entry["match_pattern"], model, re.IGNORECASE):
                return entry["prices"]
        except re.error:
            continue

    return None


def _bucket_cost_terms(
    prices: dict[str, float] | None, buckets: TokenBuckets
) -> dict[str, Decimal] | None:
    """Per-category cost terms as exact Decimals, or None when no prices are known.

    The single place the cost formula lives: each disjoint bucket priced once.
    Missing cacheRead / cacheWrite rates are treated as 0 (e.g. OpenAI has no
    cache-write rate). Both the total (cost_from_buckets) and the display-side
    breakdown (cost_breakdown_from_buckets) derive from this, so they cannot diverge.
    """
    if not prices:
        return None

    return {
        "input_uncached_cost": Decimal(buckets.input_uncached)
        * Decimal(str(prices.get("input", 0))),
        "cache_read_cost": Decimal(buckets.cache_read) * Decimal(str(prices.get("cacheRead") or 0)),
        "cache_write_cost": Decimal(buckets.cache_write)
        * Decimal(str(prices.get("cacheWrite") or 0)),
        "output_cost": Decimal(buckets.output) * Decimal(str(prices.get("output", 0))),
    }


def cost_from_buckets(prices: dict[str, float] | None, buckets: TokenBuckets) -> float | None:
    """Price DISJOINT token buckets — the single source of truth for total cost.

    Returns None when no prices are known, so callers can leave cost unset rather
    than recording $0. Both the inline ingest path (otel_transform.py) and
    calculate_cost() call this, so the cost formula lives in exactly one place.
    """
    terms = _bucket_cost_terms(prices, buckets)
    if terms is None:
        return None
    return float(sum(terms.values()))


def cost_breakdown_from_buckets(
    prices: dict[str, float] | None, buckets: TokenBuckets
) -> dict[str, float] | None:
    """Per-category dollar breakdown behind a span's single `cost`.

    Returns a dict keyed input_uncached_cost / cache_read_cost / cache_write_cost /
    output_cost, or None when no prices are known (same contract as
    cost_from_buckets). Summing the values reproduces cost_from_buckets. Display-only.
    """
    terms = _bucket_cost_terms(prices, buckets)
    if terms is None:
        return None
    return {key: float(value) for key, value in terms.items()}


def calculate_cost(
    model: str,
    input_text: str | None,
    output_text: str | None,
) -> dict[str, int | float | None]:
    """Calculate token usage and cost.

    Returns:
        Dict with input_tokens, output_tokens, total_tokens, cost.
        Returns empty values if model not found.
    """
    result: dict[str, int | float | None] = {
        "input_tokens": None,
        "output_tokens": None,
        "total_tokens": None,
        "cost": None,
    }

    if not model:
        return result

    input_tokens = count_tokens(input_text, model)
    output_tokens = count_tokens(output_text, model)
    total_tokens = input_tokens + output_tokens

    result["input_tokens"] = input_tokens
    result["output_tokens"] = output_tokens
    result["total_tokens"] = total_tokens

    prices = get_model_price(model)
    if prices:
        # Text estimation has no cache visibility, so cache buckets are zero.
        # Routing through cost_from_buckets keeps one cost formula across paths.
        result["cost"] = cost_from_buckets(
            prices,
            TokenBuckets(
                input_uncached=input_tokens,
                output=output_tokens,
                cache_read=0,
                cache_write=0,
            ),
        )

    return result
