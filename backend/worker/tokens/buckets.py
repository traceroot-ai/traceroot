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
    """

    input_uncached: int = 0
    output: int = 0
    cache_read: int = 0
    cache_write: int = 0


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
        "ai",  # Vercel AI SDK tracer; GROSS input with cache detail under ai.usage.*
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


def normalize_token_usage(
    scope_name: str | None,
    *,
    input_tokens: int,
    output_tokens: int,
    cache_read_tokens: int,
    cache_write_tokens: int,
) -> TokenBuckets:
    """Convert an instrumentor's token counts into disjoint priced buckets.

    The uncached bucket is ``max(input - cache_read - cache_write, 0)``; cache is
    kept uncapped. This is correct for GROSS emitters (cache is a subset of the
    input, so it subtracts out) and for NET emitters such as claude-agent-sdk
    (cache exceeds the input, so the uncached bucket floors to zero while the
    additive cache is still priced in full). All buckets are clamped non-negative.
    """
    _warn_once_if_unknown_scope(scope_name)
    cache_read = max(cache_read_tokens, 0)
    cache_write = max(cache_write_tokens, 0)
    return TokenBuckets(
        input_uncached=max(max(input_tokens, 0) - cache_read - cache_write, 0),
        output=max(output_tokens, 0),
        cache_read=cache_read,
        cache_write=cache_write,
    )
