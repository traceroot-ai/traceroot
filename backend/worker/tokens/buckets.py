"""Normalize an instrumentor's token counts into DISJOINT priced buckets — each
physical token in exactly one bucket, priced once.

The reported input may be GROSS (cache-inclusive — the common case, e.g.
OpenInference's ``llm.token_count.prompt``, which already contains the cache
tokens) or NET (cache-exclusive — e.g. the claude-agent-sdk instrumentor, which
passes Anthropic's exclusive ``input_tokens`` straight through with cache reported
as separate additive buckets).

A single rule handles both: subtract cache from the input to recover the uncached
bucket, flooring at zero, and keep the cache buckets UNCAPPED. For gross emitters
the cache is a subset that subtracts cleanly; for net emitters the cache simply
exceeds the input, so the uncached bucket floors to zero while the additive cache
is still priced in full. Each physical token is therefore priced exactly once
without a per-emitter convention branch.

Cache WRITES can additionally carry a TTL split: Anthropic prices a 1-hour write at
2.0x base input, versus 1.25x for the default 5-minute write (reads are 0.1x
regardless of TTL). Since the existing ``cacheWrite`` rate already IS the 5-minute
rate, only the 1-hour portion needs its own rate; it is modeled as a SUB-PARTITION
of the ``cache_write`` total, never as a new disjoint bucket::

    cache_write  =  cache_write_1h  +  remainder
                    \\_ priced at _/    \\__ priced at the combined cacheWrite rate
                       cacheWrite1h          (the 5-minute / default write rate)

Keeping ``cache_write`` as the single total means the gross-input reconstruction
(uncached + cache_read + cache_write) is unchanged, and any emitter that does not
report the 1-hour portion (every emitter today) is priced exactly as before.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class TokenBuckets:
    """Disjoint token buckets — each physical token is in exactly one bucket.

    Fields default to ``0`` so new token categories (e.g. reasoning, audio) can be
    added as purely additive changes without touching existing call sites.

    ``cache_write_1h`` is NOT an additional disjoint bucket: it is a sub-partition of
    ``cache_write`` (``cache_write_1h <= cache_write``), used only to price the 1-hour
    write rate. It defaults to ``0``, so an emitter that does not report the 1-hour
    portion prices identically to before.
    """

    input_uncached: int = 0
    output: int = 0
    cache_read: int = 0
    cache_write: int = 0
    cache_write_1h: int = 0


# Instrumentation scopes traceroot recognizes today. Used only to surface an
# UNKNOWN emitter once (so a new token convention gets a human look) — the pricing
# math below is the same for every scope. Matched by case-insensitive prefix.
_KNOWN_SCOPE_PREFIXES: tuple[str, ...] = (
    "openinference",  # Python OpenInference (openinference.instrumentation.*)
    "@arizeai/openinference",  # JS/TS OpenInference (@arizeai/openinference-instrumentation-*)
    "opentelemetry.instrumentation",
    "pydantic",  # pydantic-ai / pydantic_ai
    "logfire",
    "traceroot",
)

# Scopes recognized by EXACT name — too short to prefix-match safely (a bare
# "ai" prefix would also swallow unrelated ai*-named scopes).
_KNOWN_SCOPE_EXACT: frozenset[str] = frozenset(
    {
        "ai",  # Vercel AI SDK legacy tracer; GROSS input with cache detail under ai.usage.*
        # Vercel AI SDK semconv tracer; same GROSS usage source as "ai", emitted
        # under gen_ai.usage.* instead.
        "gen_ai",
    }
)

# Bound the dedup set so a high-cardinality (or adversarial) stream of unknown
# scope names cannot grow it without limit. Real emitters are few; this ceiling
# is far above any legitimate count.
_MAX_WARNED_SCOPES = 1024
_warned_scopes: set[str] = set()


def _warn_once_if_unknown_scope(scope_name: str | None) -> None:
    """Warn (once per scope) if the emitter isn't one traceroot recognizes.

    ``scope_name`` is typed ``str | None`` but comes from untrusted OTLP, so a
    malformed (non-string) value is guarded — it must never crash ingestion.
    """
    if isinstance(scope_name, str):
        lowered = scope_name.lower()
        if lowered in _KNOWN_SCOPE_EXACT or lowered.startswith(_KNOWN_SCOPE_PREFIXES):
            return
    key = scope_name if isinstance(scope_name, str) and scope_name else "<missing>"
    if key not in _warned_scopes and len(_warned_scopes) < _MAX_WARNED_SCOPES:
        _warned_scopes.add(key)
        logger.warning(
            "Pricing tokens from unknown instrumentation scope %r; verify its "
            "token convention and add it to _KNOWN_SCOPE_PREFIXES or _KNOWN_SCOPE_EXACT.",
            key,
        )


def reconcile_cache_write_1h(cache_write: int, cache_write_1h: int) -> int:
    """Clamp the 1-hour cache-write portion to a valid sub-partition of the write total.

    Returns ``cache_write_1h`` clamped non-negative and capped at ``cache_write`` (also
    floored at 0), so the portion can never over-count the write total (the leftover
    ``cache_write - cache_write_1h`` is the remainder priced at the combined cache-write
    rate). Deterministic for any input. Shared by the ingest path (normalize_token_usage)
    and the read path (span_cost_details).
    """
    return min(max(cache_write_1h, 0), max(cache_write, 0))


def normalize_token_usage(
    scope_name: str | None,
    *,
    input_tokens: int,
    output_tokens: int,
    cache_read_tokens: int,
    cache_write_tokens: int,
    cache_write_1h_tokens: int = 0,
) -> TokenBuckets:
    """Convert an instrumentor's token counts into disjoint priced buckets.

    The uncached bucket is ``max(input - cache_read - cache_write, 0)``; cache is
    kept uncapped. This is correct for GROSS emitters (cache is a subset of the
    input, so it subtracts out) and for NET emitters such as claude-agent-sdk
    (cache exceeds the input, so the uncached bucket floors to zero while the
    additive cache is still priced in full). All buckets are clamped non-negative.

    ``cache_write_1h_tokens`` is an OPTIONAL 1-hour portion of the cache-write total.
    It is reconciled against ``cache_write`` so the sub-partition invariant always
    holds even for malformed input: clamped non-negative and capped so
    ``cache_write_1h <= cache_write`` (the remainder is priced at the combined
    cache-write rate). Defaults to ``0``, so an emitter that does not report the
    1-hour portion (every emitter today) is unaffected.
    """
    _warn_once_if_unknown_scope(scope_name)
    cache_read = max(cache_read_tokens, 0)
    cache_write = max(cache_write_tokens, 0)
    cache_write_1h = reconcile_cache_write_1h(cache_write, cache_write_1h_tokens)
    return TokenBuckets(
        input_uncached=max(max(input_tokens, 0) - cache_read - cache_write, 0),
        output=max(output_tokens, 0),
        cache_read=cache_read,
        cache_write=cache_write,
        cache_write_1h=cache_write_1h,
    )
