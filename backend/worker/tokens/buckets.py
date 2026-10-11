"""Normalize an instrumentor's token counts into DISJOINT priced buckets — each
physical token in exactly one bucket, priced once.

The reported input may be GROSS (cache-inclusive — the common case, e.g.
OpenInference's ``llm.token_count.prompt``, OpenAI's ``prompt_tokens`` and
Gemini's ``promptTokenCount``, which already contain the cache tokens) or NET
(cache-exclusive — an emitter that passes the provider's exclusive input count
straight through with cache reported as separate additive buckets, which is how
Anthropic and Bedrock Converse report ``input_tokens``).

The two conventions need different math, so the convention is resolved per span
(``resolve_input_is_net``) and the buckets branch once on it:

- GROSS: the cache is a subset of the input, so
  ``uncached = input - cache_read - cache_write`` (floored at zero).
- NET: the input IS the uncached bucket, so ``uncached = input`` and the cache
  buckets are additive on top.

Subtracting under the net convention floors the uncached bucket to zero, so the
uncached tokens are priced zero times. The cache buckets are kept UNCAPPED under
both conventions.

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
report the 1-hour portion is priced exactly as before.
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
    # npm-scoped traceroot emitters: @traceroot-ai/pi-extension,
    # @traceroot-ai/claude-agent-sdk, @traceroot-ai/pi-coding-agent. "traceroot"
    # above does not prefix-match the leading "@".
    "@traceroot-ai/",
    # Traceloop JS/TS instrumentations (@traceloop/instrumentation-*). The Python
    # ones use "opentelemetry.instrumentation.*" above.
    "@traceloop/",
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


# Emitters known to report the input NET of cache, keyed on the lowercased
# instrumentation scope name. The value is the newest version that is still net
# (inclusive), or ``None`` when every version is. Anything not listed is GROSS.
#
# Deliberately NOT keyed on the model or provider: OpenInference, traceroot's
# Claude Agent SDK wrappers, Traceloop Python and pydantic-ai all emit GROSS
# Claude spans, so a "model starts with claude" rule would double-count them.
_NET_INPUT_SCOPES: dict[str, tuple[int, ...] | None] = {
    # traceroot-pi-extension src/handlers/llm.ts: pi-ai subtracts the cache from
    # the provider's count before emitting, for Anthropic and OpenAI alike.
    "@traceroot-ai/pi-extension": None,
    # traceroot-ts packages/traceroot/src/pi.ts: the same pi-ai usage shape.
    "@traceroot-ai/pi-coding-agent": None,
    # instrumentation.ts passes Anthropic's input_tokens through up to 0.27.0.
    # Later versions sum the three fields before emitting.
    "@traceloop/instrumentation-anthropic": (0, 27, 0),
    # JS OpenInference Bedrock, attributes/invoke-model-helpers.ts: InvokeModel
    # passes the provider's input through for Claude (input_tokens) and Nova
    # (inputTokens), and Bedrock reports both net of cache. Its Converse path
    # emits no cache attributes, so the convention cannot matter there.
    "@arizeai/openinference-instrumentation-bedrock": None,
    # NOT listed: Python OpenInference Bedrock (openinference.instrumentation.
    # bedrock). That one scope is mixed: Converse passes the net inputTokens
    # through, while InvokeModel on Claude sums the three fields into a gross
    # prompt. A scope-level entry would price the cache twice on the second, so
    # its Converse spans are left to the provable-net fallback.
}

_warned_net_fallback_scopes: set[str] = set()


def _parse_version(version: object) -> tuple[int, ...] | None:
    """Parse the leading ``major.minor.patch`` of a scope version.

    ``version`` comes from untrusted OTLP, so anything that is not a string with
    a numeric ``x.y.z`` prefix returns ``None``. A pre-release or build suffix
    (``0.27.0-beta.1``, ``0.27.0+sha``) is ignored.
    """
    if not isinstance(version, str):
        return None
    core = version.strip().lstrip("vV").split("-", 1)[0].split("+", 1)[0]
    parts = core.split(".")
    if not 1 <= len(parts) <= 3 or not all(p.isdigit() and len(p) <= 9 for p in parts):
        return None
    numbers = [int(p) for p in parts]
    return tuple(numbers + [0] * (3 - len(numbers)))


def _scope_reports_net_input(scope_name: object, scope_version: object) -> bool:
    """Whether the emitter table lists this scope (and version) as NET."""
    if not isinstance(scope_name, str):
        return False
    key = scope_name.lower()
    if key not in _NET_INPUT_SCOPES:
        return False
    last_net_version = _NET_INPUT_SCOPES[key]
    if last_net_version is None:
        return True
    parsed = _parse_version(scope_version)
    # An unversioned span cannot be placed on either side of the cutoff, so it is
    # left to the provable-net fallback instead of being guessed.
    return parsed is not None and parsed <= last_net_version


def resolve_input_is_net(
    scope_name: str | None,
    scope_version: str | None = None,
    *,
    explicit: bool | None = None,
    input_tokens: int,
    cache_read_tokens: int,
    cache_write_tokens: int,
) -> bool:
    """Decide whether a span's reported input is NET of cache.

    Resolved in this order:

    1. ``explicit`` — the reporter said so (``traceroot.llm.usage.input_is_net``
       or ``input_is_net`` in the manual usage dict). Always wins.
    2. The emitter table (``_NET_INPUT_SCOPES``), keyed on scope name and version.
    3. Provable-net fallback: a GROSS input contains its cache, so
       ``cache_read + cache_write > input`` can only come from a NET emitter.
       Warns once per scope so the emitter can be added to the table.

    Everything else is GROSS. An unknown NET emitter whose cache does not exceed
    its input is still treated as gross, which under-prices it by the cache
    tokens; it is never floored to zero.
    """
    if isinstance(explicit, bool):
        return explicit
    if _scope_reports_net_input(scope_name, scope_version):
        return True
    if max(cache_read_tokens, 0) + max(cache_write_tokens, 0) > max(input_tokens, 0):
        key = scope_name if isinstance(scope_name, str) and scope_name else "<missing>"
        if (
            key not in _warned_net_fallback_scopes
            and len(_warned_net_fallback_scopes) < _MAX_WARNED_SCOPES
        ):
            _warned_net_fallback_scopes.add(key)
            logger.warning(
                "Instrumentation scope %r reported more cache tokens than input tokens; "
                "treating its input as net of cache. Add it to _NET_INPUT_SCOPES or set "
                "traceroot.llm.usage.input_is_net on the span.",
                key,
            )
        return True
    return False


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
    scope_version: str | None = None,
    input_is_net: bool | None = None,
) -> TokenBuckets:
    """Convert an instrumentor's token counts into disjoint priced buckets.

    The input convention is resolved first (``resolve_input_is_net``):
    ``input_is_net`` is the reporter's explicit override, otherwise it is derived
    from ``scope_name`` and ``scope_version``. For a GROSS input the uncached
    bucket is ``max(input - cache_read - cache_write, 0)``; for a NET input it is
    the input itself. Cache is kept uncapped either way. All buckets are clamped
    non-negative.

    ``cache_write_1h_tokens`` is an OPTIONAL 1-hour portion of the cache-write total.
    It is reconciled against ``cache_write`` so the sub-partition invariant always
    holds even for malformed input: clamped non-negative and capped so
    ``cache_write_1h <= cache_write`` (the remainder is priced at the combined
    cache-write rate). Defaults to ``0``, so an emitter that does not report the
    1-hour portion is unaffected.
    """
    _warn_once_if_unknown_scope(scope_name)
    reported_input = max(input_tokens, 0)
    cache_read = max(cache_read_tokens, 0)
    cache_write = max(cache_write_tokens, 0)
    cache_write_1h = reconcile_cache_write_1h(cache_write, cache_write_1h_tokens)
    is_net = resolve_input_is_net(
        scope_name,
        scope_version,
        explicit=input_is_net,
        input_tokens=reported_input,
        cache_read_tokens=cache_read,
        cache_write_tokens=cache_write,
    )
    input_uncached = reported_input if is_net else max(reported_input - cache_read - cache_write, 0)
    return TokenBuckets(
        input_uncached=input_uncached,
        output=max(output_tokens, 0),
        cache_read=cache_read,
        cache_write=cache_write,
        cache_write_1h=cache_write_1h,
    )
