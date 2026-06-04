"""Normalize gross (cache-inclusive) instrumentor token counts into DISJOINT
priced buckets — each physical token in exactly one bucket, priced once.

Every instrumentor traceroot ingests reports a GROSS input that already contains
the cache read/write tokens (per the OpenTelemetry GenAI semconv, where
``gen_ai.usage.input_tokens`` is the *total* prompt:
https://opentelemetry.io/docs/specs/semconv/gen-ai/anthropic/). We subtract cache
from the input so the downstream cost math prices each token exactly once.
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


# Instrumentation scopes known to report a GROSS (cache-inclusive) input — every
# emitter traceroot reads today. Matched by case-insensitive scope-name prefix.
# An unrecognized scope is still treated as inclusive (the dominant convention)
# but warned about once, so a future raw-passthrough emitter surfaces instead of
# silently mispricing. Add a prefix here only after verifying the emitter is
# cache-inclusive firsthand from its source (NOT from raw provider API docs — the
# raw SDK field can be exclusive while the instrumented span is gross).
_KNOWN_INCLUSIVE_SCOPE_PREFIXES: tuple[str, ...] = (
    "openinference",  # Python OpenInference (openinference.instrumentation.*)
    "@arizeai/openinference",  # JS/TS OpenInference (@arizeai/openinference-instrumentation-*)
    "opentelemetry.instrumentation",
    "pydantic",  # pydantic-ai / pydantic_ai
    "logfire",
    "traceroot",
)

# Bound the dedup set so a high-cardinality (or adversarial) stream of unknown
# scope names cannot grow it without limit. Real emitters are few; this ceiling
# is far above any legitimate count.
_MAX_WARNED_SCOPES = 1024
_warned_scopes: set[str] = set()


def _warn_once_if_unknown_scope(scope_name: str | None) -> None:
    """Warn (once per scope) if the emitter isn't a known cache-inclusive one."""
    if scope_name and scope_name.lower().startswith(_KNOWN_INCLUSIVE_SCOPE_PREFIXES):
        return
    key = scope_name or "<missing>"
    if key not in _warned_scopes and len(_warned_scopes) < _MAX_WARNED_SCOPES:
        _warned_scopes.add(key)
        logger.warning(
            "Pricing tokens from unknown instrumentation scope %r; assuming "
            "input is cache-inclusive (subtracting cache). Verify this emitter's "
            "convention and add it to _KNOWN_INCLUSIVE_SCOPE_PREFIXES.",
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
    """Convert a gross (cache-inclusive) instrumentor count into disjoint buckets.

    Cache is subtracted from the gross input so each physical token is priced
    exactly once. All buckets are clamped non-negative, and cache is capped to the
    gross input so inconsistent emitter data (cache counts exceeding the reported
    input) can never price more tokens than were reported. The reconciliation
    invariant ``input_uncached + cache_read + cache_write == input_tokens`` holds.
    """
    _warn_once_if_unknown_scope(scope_name)
    gross_input = max(input_tokens, 0)
    cache_read = min(max(cache_read_tokens, 0), gross_input)
    cache_write = min(max(cache_write_tokens, 0), gross_input - cache_read)
    return TokenBuckets(
        input_uncached=gross_input - cache_read - cache_write,
        output=max(output_tokens, 0),
        cache_read=cache_read,
        cache_write=cache_write,
    )
