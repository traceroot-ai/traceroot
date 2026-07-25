"""Model pricing and cost calculation.

Prices are loaded from the ``standard_models`` / ``standard_model_prices``
PostgreSQL tables (synced from standard-model-prices.json by the TS services).
The in-memory cache is populated on first call and persists for the process
lifetime (prices only change on deploy/restart).
"""

from __future__ import annotations

import logging
import re
from decimal import Decimal

import psycopg2

from shared.config import settings

from .buckets import TokenBuckets, reconcile_cache_write_1h
from .usage import count_tokens

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# In-memory cache (populated on first call)
# ---------------------------------------------------------------------------

_cache: list[dict] | None = None


def _load_cache() -> list[dict]:
    global _cache
    if _cache is not None:
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
    return _cache


# ---------------------------------------------------------------------------
# Public API (unchanged signatures)
# ---------------------------------------------------------------------------


# Gateway / router prefixes that wrap an underlying model id. pi-ai's `response.model`
# (and LiteLLM / OpenRouter / Vertex setups) carries these, so the raw id never matches a
# catalog pattern and cost silently resolves to $0 on metered paths. Stripping them is the
# NORMALISE step of the resolution contract; keep this list identical to the TS resolver.
_GATEWAY_PREFIXES = (
    "vertex_ai/",
    "openrouter/",
    "litellm/",
    "azure/",
    "bedrock/",
    "anthropic_vertex/",
    "gemini/",
)


def normalize_model_id(model: str) -> str:
    """Strip gateway/router prefixes from a model id (repeatedly — they can nest).

    Deliberately conservative: only strips the known prefixes above, so a legitimate id
    containing a slash (``anthropic/claude-...``, which real patterns already match) is
    left alone.
    """
    if not model:
        return model
    out = model.strip()
    changed = True
    while changed:
        changed = False
        low = out.lower()
        for prefix in _GATEWAY_PREFIXES:
            if low.startswith(prefix):
                out = out[len(prefix):]
                changed = True
                break
    return out


def _match_specificity(entry: dict, model: str) -> tuple[int, str]:
    """Rank a regex match so the MOST SPECIFIC entry wins, not merely the first.

    ``claude-sonnet-4``'s pattern also matches ``claude-sonnet-4-5``/``-4-6`` (their
    optional version tails subsume successors). First-match-wins therefore depends on row
    order and can price a successor at its predecessor's rates the day they differ.
    Longest model_name = most specific; model_name breaks ties deterministically.
    """
    return (len(entry["model_name"]), entry["model_name"])


def get_model_price(model: str) -> dict[str, float] | None:
    """Lookup price for model.

    Resolution contract (must stay identical to the TS ``getModelPricing``):
      1. exact match on ``model_name``
      2. exact match on the NORMALISED id (gateway prefixes stripped)
      3. regex fallback over ``match_pattern`` — most-specific match wins, evaluated
         against both the raw and normalised id

    Returns dict with keys like ``input``, ``output``, ``cacheRead``, ``cacheWrite``
    (values in USD per token), or None if not found.
    """
    cache = _load_cache()
    normalized = normalize_model_id(model)
    candidates = [model] if normalized == model else [model, normalized]

    # 1 + 2. Exact match on the raw id, then on the normalised id.
    for candidate in candidates:
        for entry in cache:
            if entry["model_name"] == candidate:
                return entry["prices"]

    # 3. Regex fallback — collect EVERY match and take the most specific one, so the
    #    result no longer depends on row order (see _match_specificity).
    best: dict | None = None
    best_rank: tuple[int, str] | None = None
    for entry in cache:
        try:
            pattern = entry["match_pattern"]
            if not any(re.search(pattern, c, re.IGNORECASE) for c in candidates):
                continue
        except re.error:
            continue
        rank = _match_specificity(entry, model)
        if best_rank is None or rank > best_rank:
            best, best_rank = entry, rank

    return best["prices"] if best else None


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
