"""Model pricing and cost calculation.

Prices are loaded from the ``standard_models`` / ``standard_model_prices``
PostgreSQL tables (synced from standard-model-prices.json by the TS services).
The in-memory cache is populated on first call and persists for the process
lifetime (prices only change on deploy/restart).
"""

from __future__ import annotations

import logging
import re
import time
from decimal import Decimal

import psycopg2

from shared.config import settings
from shared.span_attributes import COST_SOURCE_CATALOG, COST_SOURCE_CUSTOM

from .buckets import TokenBuckets, reconcile_cache_write_1h
from .usage import count_tokens

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# In-memory caches (with TTL-based refresh per #1096)
# ---------------------------------------------------------------------------

_cache: list[dict] | None = None
_cache_loaded_at: float = 0.0
_CATALOG_CACHE_TTL = 300.0  # 5 minutes

_workspace_prices_cache: dict[str, tuple[float, list[dict]]] = {}
_WORKSPACE_CACHE_TTL = 60.0  # 60 seconds TTL for workspace custom prices

_project_workspace_cache: dict[str, tuple[float, str | None]] = {}
_PROJECT_WORKSPACE_CACHE_TTL = 300.0  # 5 minutes TTL for project->workspace mapping


def _load_cache() -> list[dict]:
    global _cache, _cache_loaded_at
    now = time.monotonic()
    if _cache is not None and (now - _cache_loaded_at) < _CATALOG_CACHE_TTL:
        return _cache

    models: list[dict] = []
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
        # DB unavailable — return empty list but do NOT cache,
        # so the next call will retry the connection.
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

    models = list(by_model.values())
    _cache = models
    _cache_loaded_at = now
    return _cache


def get_workspace_id_for_project(project_id: str | None) -> str | None:
    """Resolve project_id to its owning workspace_id with in-memory TTL caching."""
    if not project_id:
        return None
    now = time.monotonic()
    cached = _project_workspace_cache.get(project_id)
    if cached and now < cached[0]:
        return cached[1]

    workspace_id = None
    try:
        conn = psycopg2.connect(settings.database_url)
        try:
            with conn.cursor() as cur:
                cur.execute("SELECT workspace_id FROM projects WHERE id = %s", (project_id,))
                row = cur.fetchone()
                if row:
                    workspace_id = str(row[0]) if row[0] is not None else None
        finally:
            conn.close()
    except Exception as exc:
        logger.debug("Failed to lookup workspace_id for project %s: %s", project_id, exc)
        return None

    _project_workspace_cache[project_id] = (now + _PROJECT_WORKSPACE_CACHE_TTL, workspace_id)
    return workspace_id


def _load_workspace_prices(workspace_id: str) -> list[dict]:
    """Load workspace-registered custom model prices with 60s TTL cache (#1096)."""
    now = time.monotonic()
    cached = _workspace_prices_cache.get(workspace_id)
    if cached and now < cached[0]:
        return cached[1]

    models: list[dict] = []
    try:
        conn = psycopg2.connect(settings.database_url)
        try:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    SELECT model_name, match_pattern, input_price, output_price, cache_read_price, cache_write_price
                    FROM workspace_model_prices
                    WHERE workspace_id = %s
                    ORDER BY model_name
                    """,
                    (workspace_id,),
                )
                rows = cur.fetchall()
        finally:
            conn.close()
    except Exception as exc:
        logger.debug(
            "Failed to load workspace model prices from DB for workspace %s: %s",
            workspace_id,
            exc,
        )
        return []

    for (
        model_name,
        match_pattern,
        input_price,
        output_price,
        cache_read_price,
        cache_write_price,
    ) in rows:
        prices = {
            "input": float(input_price or 0.0),
            "output": float(output_price or 0.0),
        }
        if cache_read_price is not None:
            prices["cacheRead"] = float(cache_read_price)
        if cache_write_price is not None:
            prices["cacheWrite"] = float(cache_write_price)

        models.append(
            {
                "model_name": model_name,
                "match_pattern": match_pattern,
                "prices": prices,
            }
        )

    _workspace_prices_cache[workspace_id] = (now + _WORKSPACE_CACHE_TTL, models)
    return models


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


def _get_catalog_price(model: str) -> dict[str, float] | None:
    catalog = _load_cache()
    # Exact match on model_name
    for entry in catalog:
        if entry["model_name"] == model:
            return entry["prices"]

    # Regex fallback using match_pattern
    for entry in catalog:
        try:
            if re.search(entry["match_pattern"], model, re.IGNORECASE):
                return entry["prices"]
        except re.error:
            continue

    return None


def get_model_price(
    model: str,
    workspace_id: str | None = None,
    project_id: str | None = None,
) -> dict[str, float] | None:
    """Lookup price for model. Returns dict of USD per-token prices or None."""
    resolved_workspace_id = workspace_id or get_workspace_id_for_project(project_id)
    if resolved_workspace_id:
        ws_prices = _load_workspace_prices(resolved_workspace_id)
        for entry in ws_prices:
            if entry["model_name"] == model or entry["model_name"].lower() == model.lower():
                return entry["prices"]
        for entry in ws_prices:
            pattern = entry.get("match_pattern")
            if pattern:
                try:
                    if re.search(pattern, model, re.IGNORECASE):
                        return entry["prices"]
                except re.error:
                    continue

    return _get_catalog_price(model)


def get_model_price_with_source(
    model: str,
    workspace_id: str | None = None,
    project_id: str | None = None,
) -> tuple[dict[str, float] | None, str | None]:
    """Lookup price and provenance for model.

    Precedence:
    1. Workspace custom model pricing (exact match, then regex match) -> 'custom'
    2. Built-in standard catalog (exact match, then regex match) -> 'catalog'
    3. Not found -> (None, None)
    """
    resolved_workspace_id = workspace_id or get_workspace_id_for_project(project_id)
    if resolved_workspace_id:
        ws_prices = _load_workspace_prices(resolved_workspace_id)
        for entry in ws_prices:
            if entry["model_name"] == model or entry["model_name"].lower() == model.lower():
                return entry["prices"], COST_SOURCE_CUSTOM
        for entry in ws_prices:
            pattern = entry.get("match_pattern")
            if pattern:
                try:
                    if re.search(pattern, model, re.IGNORECASE):
                        return entry["prices"], COST_SOURCE_CUSTOM
                except re.error:
                    continue

    # Fall back to get_model_price (honors patches/mocks in tests)
    catalog_prices = get_model_price(model)
    if catalog_prices is not None:
        return catalog_prices, COST_SOURCE_CATALOG

    return None, None


def _rate(prices: dict[str, float], key: str, *fallbacks: str) -> Decimal:
    """Resolve a per-token rate as an exact Decimal, trying ``key`` then fallbacks.

    A missing/null/zero rate falls through to the next key, and an absent rate is 0
    (e.g. OpenAI has no cache-write rate). Lets the per-TTL cache-write rates fall
    back to the combined ``cacheWrite`` rate when a model doesn't distinguish TTLs.
    """
    for name in (key, *fallbacks):
        value = prices.get(name)
        if value:
            return Decimal(str(value))
    return Decimal(0)


def _bucket_cost_terms(
    prices: dict[str, float] | None, buckets: TokenBuckets
) -> dict[str, Decimal] | None:
    """Per-category cost terms as exact Decimals, or None when no prices are known.

    The single place the cost formula lives: each disjoint bucket priced once.
    Missing cacheRead / cacheWrite rates are treated as 0 (e.g. OpenAI has no
    cache-write rate). Both the total (cost_from_buckets) and the display-side
    breakdown (cost_breakdown_from_buckets) derive from this, so they cannot diverge.

    Every count is clamped non-negative before pricing, so the cost can never go
    negative and the formula matches the TS helper (calculateCostFromPricing) for any
    input. For real traffic (all counts already >= 0) the clamps are no-ops, so the
    result is identical to the unclamped formula.

    The cache-write term prices the optional 1-hour portion as a sub-partition of the
    write total: the 1-hour portion at its own rate (falling back to ``cacheWrite``
    when a model doesn't distinguish TTLs) and the remainder at the combined
    ``cacheWrite`` rate (which already IS the 5-minute / default write rate). When no
    1-hour portion is reported the remainder equals the whole write total, so the term
    is identical to ``cache_write * cacheWrite``. ``cache_write_cost`` stays a single
    canonical term, so the total never double-counts.
    """
    if not prices:
        return None

    # Reconcile the 1-hour portion here too — this is the single source of truth for
    # the cost formula, so it must price each write token once for ANY TokenBuckets,
    # not only ones built through normalize_token_usage. The total is clamped
    # non-negative first (mirrors the TS helper) so a malformed negative total can
    # never produce a negative cost; remainder = the cache-write tokens with no 1-hour
    # attribution, priced at the combined cacheWrite rate.
    cache_write_total = max(buckets.cache_write, 0)
    cache_write_1h = reconcile_cache_write_1h(cache_write_total, buckets.cache_write_1h)
    cache_write_remainder = cache_write_total - cache_write_1h
    cache_write_cost = Decimal(cache_write_remainder) * _rate(prices, "cacheWrite") + Decimal(
        cache_write_1h
    ) * _rate(prices, "cacheWrite1h", "cacheWrite")

    return {
        "input_uncached_cost": Decimal(max(buckets.input_uncached, 0)) * _rate(prices, "input"),
        "cache_read_cost": Decimal(max(buckets.cache_read, 0)) * _rate(prices, "cacheRead"),
        "cache_write_cost": cache_write_cost,
        "output_cost": Decimal(max(buckets.output, 0)) * _rate(prices, "output"),
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
