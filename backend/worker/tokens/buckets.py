"""Normalize provider/instrumentor token counts into DISJOINT priced buckets.

Every instrumentor traceroot ingests reports a GROSS (cache-inclusive) input
count — the cache read/write tokens are a *breakdown of* the input, not
additive to it. Verified firsthand from installed source (see
issue-956-token-cost-worklog.html §2): OpenInference Anthropic/OpenAI,
pydantic-ai/genai-prices, and Langfuse all behave this way; the OpenTelemetry
GenAI semconv mandates it ("input_tokens SHOULD include ... cached tokens").

We therefore subtract cache from the input to get disjoint buckets, so the
downstream cost math can price each physical token exactly once with zero
provider branches. The convention is keyed on the OTel instrumentation *scope*
(the emitter), not the provider name — that is where the convention actually
varies. Today every known emitter is inclusive, so the table collapses to
"subtract everywhere"; the EXCLUSIVE branch + unknown-scope warning are the
extension point for a hypothetical future raw-passthrough emitter.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from enum import Enum

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class TokenBuckets:
    """Disjoint token buckets — each physical token is in exactly one bucket."""

    input_uncached: int
    output: int
    cache_read: int
    cache_write: int


class InputConvention(Enum):
    INCLUSIVE = "inclusive"  # input already contains cache -> subtract
    EXCLUSIVE = "exclusive"  # input excludes cache -> additive (no known emitter)


# Matched by scope-name prefix (case-insensitive). Every emitter traceroot
# reads today is INCLUSIVE. Add an EXCLUSIVE entry here only after verifying a
# new emitter firsthand from its source (NOT from raw provider API docs — the
# raw SDK field can be exclusive while the instrumented span is gross).
_SCOPE_CONVENTIONS: tuple[tuple[str, InputConvention], ...] = (
    ("openinference", InputConvention.INCLUSIVE),
    ("opentelemetry.instrumentation", InputConvention.INCLUSIVE),
    ("pydantic", InputConvention.INCLUSIVE),  # pydantic-ai / pydantic_ai
    ("logfire", InputConvention.INCLUSIVE),
    ("traceroot", InputConvention.INCLUSIVE),
)

# Safe default: the dominant convention is inclusive, so an unrecognized emitter
# is far more likely to be gross than net. We subtract and warn rather than risk
# a silent ~2x overcharge.
_DEFAULT_CONVENTION = InputConvention.INCLUSIVE

_warned_scopes: set[str] = set()


def _convention_for_scope(scope_name: str | None) -> InputConvention:
    if scope_name:
        lowered = scope_name.lower()
        for prefix, convention in _SCOPE_CONVENTIONS:
            if lowered.startswith(prefix):
                return convention
    # Unknown / missing scope: warn once per scope so a future emitter surfaces
    # instead of silently mispricing.
    key = scope_name or "<missing>"
    if key not in _warned_scopes:
        _warned_scopes.add(key)
        logger.warning(
            "Pricing tokens from unknown instrumentation scope %r; assuming "
            "input is cache-inclusive (subtracting cache). Verify this emitter's "
            "convention and add it to _SCOPE_CONVENTIONS.",
            key,
        )
    return _DEFAULT_CONVENTION


def normalize_token_usage(
    scope_name: str | None,
    *,
    input_tokens: int,
    output_tokens: int,
    cache_read_tokens: int,
    cache_write_tokens: int,
) -> TokenBuckets:
    """Convert gross instrumentor counts into disjoint priced buckets.

    All returned bucket values are clamped to be non-negative, defensive
    against inconsistent emitter data where cache counts exceed the reported
    input total.
    """
    convention = _convention_for_scope(scope_name)
    cache_read = max(cache_read_tokens, 0)
    cache_write = max(cache_write_tokens, 0)
    output = max(output_tokens, 0)
    if convention is InputConvention.INCLUSIVE:
        input_uncached = max(input_tokens - cache_read - cache_write, 0)
    else:  # EXCLUSIVE — input already excludes cache
        input_uncached = max(input_tokens, 0)
    return TokenBuckets(
        input_uncached=input_uncached,
        output=output,
        cache_read=cache_read,
        cache_write=cache_write,
    )
