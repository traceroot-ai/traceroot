"""Transform OTEL JSON data to ClickHouse format.

Converts OpenTelemetry trace data (camelCase JSON from protobuf) into the format
expected by our ClickHouse traces and spans tables.

OTEL JSON structure (camelCase - standard OTLP format):
{
  "resourceSpans": [
    {
      "resource": {"attributes": [...]},
      "scopeSpans": [
        {
          "scope": {"name": "...", "version": "..."},
          "spans": [
            {
              "traceId": "base64",
              "spanId": "base64",
              "parentSpanId": "base64",
              "name": "...",
              "kind": "SPAN_KIND_INTERNAL",
              "startTimeUnixNano": "123...",
              "endTimeUnixNano": "123...",
              "attributes": [{"key": "...", "value": {...}}],
              "status": {"code": "STATUS_CODE_OK"}
            }
          ]
        }
      ]
    }
  ]
}
"""

import base64
import json
import logging
from datetime import UTC, datetime
from typing import Any

from shared.enums import EVALUATION_SPAN_KINDS, SpanKind, SpanStatus
from shared.span_attributes import SPAN_IDS_PATH, SPAN_PATH, SPAN_TREE_ATTRIBUTES

logger = logging.getLogger(__name__)

# Scopes whose LLM spans intentionally leave per-turn token counts unset (usage is
# aggregated onto a few result spans). Skip text-based estimation for them, else the
# deliberately-empty spans get fabricated counts. Python only — the TypeScript scope
# ("@traceroot-ai/claude-agent-sdk") reports real per-turn usage and is excluded.
_SKIP_TEXT_TOKEN_ESTIMATION_SCOPES = frozenset({"traceroot.claude-agent-sdk"})


def _scope_skips_text_token_estimation(scope_name: str | None) -> bool:
    return scope_name in _SKIP_TEXT_TOKEN_ESTIMATION_SCOPES


# GenAI semconv operation names whose spans AGGREGATE the usage of their model-call
# descendants: an agent invocation, and one step within it. Emitters restate the
# children's totals on these spans, so adopting them prices the same tokens twice.
# Keyed on the operation name rather than the tracer scope: the scope is chosen by
# the emitting application (a private tracer provider can name it anything), so a
# scope-keyed check silently misses those traces. "invoke_agent" is a GenAI semconv
# operation name; "agent_step" is an emitter extension, not in the spec enum.
_AGGREGATE_USAGE_OPERATIONS = frozenset({"invoke_agent", "agent_step"})


def _span_aggregates_child_usage(
    scope_name: str | None, span_kind: str, attrs: dict[str, Any]
) -> bool:
    """Check whether a span restates the token usage of its model-call children.

    Args:
        scope_name (str | None): Instrumentation scope of the emitting tracer.
        span_kind (str): Span kind already resolved for this span.
        attrs (dict[str, Any]): Span attributes.

    Returns:
        bool: True when the span's token counts duplicate its children's and must
            neither be adopted nor re-derived from its text.
    """
    operation_name = attrs.get("gen_ai.operation.name")
    if isinstance(operation_name, str) and operation_name.lower() in _AGGREGATE_USAGE_OPERATIONS:
        return True
    # Fallback for a wrapper that reaches us without an operation name — an emitter
    # version that stops setting one would otherwise silently resume double-pricing,
    # which nothing else in the pipeline would surface. Narrow on purpose: it costs
    # nothing when the operation name is present, which is the shape observed today.
    return (
        isinstance(scope_name, str) and scope_name.lower() == "gen_ai" and span_kind != SpanKind.LLM
    )


# Attributes that are already extracted into dedicated fields
_KNOWN_ATTRIBUTE_PREFIXES = {
    "traceroot.span.input",
    "traceroot.span.output",
    "traceroot.span.type",
    "traceroot.span.metadata",
    "traceroot.span.tags",
    "traceroot.trace.",
    "traceroot.environment",
    # Nothing extracts this any more; it is listed purely to keep a
    # sender-supplied marker out of the metadata blob the UI renders.
    "traceroot.source",
    "traceroot.git.",
    "openinference.span.kind",
    "session.id",
    "session.user_id",
    "user.id",
    "input.value",
    "output.value",
    "gen_ai.",
    "llm.token_count.",
    "llm.model_name",
    "llm.input_messages",
    "llm.output_messages",
}


# Extracted attributes matched by EXACT name — a prefix entry would also swallow
# siblings that are NOT extracted (e.g. "traceroot.llm.model" prefix-matches
# traceroot.llm.model_parameters, which must flow to metadata instead).
_KNOWN_ATTRIBUTE_EXACT = frozenset(
    {
        "traceroot.llm.model",  # -> model_name column + LLM span-kind detection
        # -> token/cost pipeline (parse_manual_usage). Consumed only when a model
        # name is present (the token block is model-gated), so usage reported
        # without traceroot.llm.model is dropped entirely rather than priced.
        "traceroot.llm.usage",
    }
)


def _is_known_attribute(key: str) -> bool:
    """Check if an attribute key is already extracted into a dedicated field."""
    return key in _KNOWN_ATTRIBUTE_EXACT or any(
        key == prefix or key.startswith(prefix) for prefix in _KNOWN_ATTRIBUTE_PREFIXES
    )


def first_present(attrs: dict[str, Any], keys: list[str]) -> Any:
    """Return the value of the first key that is present (not None) in attrs.

    Uses `is not None` rather than truthiness so falsy-but-valid values like
    empty string, 0, or {} do not fall through to lower-priority keys.
    """
    for key in keys:
        value = attrs.get(key)
        if value is not None:
            return value
    return None


# Upper sanity bound per token field, shared by the manual-usage and instrumentor
# paths. Sized by the tightest downstream column, which is `cost`, not the token
# columns: every accepted count is priced into Decimal64(9) — Decimal(18,9), nine
# integer digits, so strictly under $10^9 (the same ceiling `filters/translate.py`
# derives for that type). Pricing multiplies a count by a per-token rate, and the
# catalog's most expensive model is under 1e-3/token summed across its input,
# cache, and output rates, so a bound of 10^9 prices to under $10^6 — three orders
# inside the column, which keeps the guard correct no matter what rate a future
# catalog row carries rather than resting on today's most expensive model. Any sum
# of the fields stays far inside the Int64 token columns. 10^9 tokens is orders of
# magnitude beyond any shipped context window, so nothing legitimate is near it.
_MAX_PLAUSIBLE_TOKENS = 10**9


def _usable_token_value(value: Any) -> bool:
    """Check whether a token attribute will survive ``int_or_zero`` intact.

    Single source of truth for "usable count", so the candidate-list scan and the
    coercion cannot disagree about which values are worth taking.

    Args:
        value (Any): Raw OTEL attribute value.

    Returns:
        bool: True when the value parses to a non-negative int within the
            plausible bound -- i.e. ``int_or_zero`` will return it unchanged.
    """
    if value is None or value == "" or isinstance(value, bool):
        return False
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return False
    return 0 <= parsed <= _MAX_PLAUSIBLE_TOKENS


def first_present_number(attrs: dict[str, Any], keys: list[str]) -> Any:
    """Like ``first_present`` but for numeric token attributes: skip keys whose
    value is missing or malformed (empty / non-numeric) so a malformed
    high-priority attribute cannot suppress a valid lower-priority fallback.

    Validity is exactly what ``int_or_zero`` will accept, via the shared
    ``_usable_token_value`` predicate. The two must not drift: a value this
    function returns but ``int_or_zero`` then drops to 0 gets the worst of both
    behaviours -- the malformed attribute short-circuits the candidate list AND
    resolves to nothing, so a perfectly good lower-priority fallback is never
    reached and the span is stored with no usage at all.

    Returns the first usable value, or None if none qualify.
    """
    for key in keys:
        if _usable_token_value(attrs.get(key)):
            return attrs.get(key)
    return None


def int_or_zero(value: Any) -> int:
    """Convert a present OTEL numeric attribute to int; missing/invalid -> 0.

    ``first_present`` returns falsy-but-present values (e.g. an empty string for
    an attribute that exists with a non-numeric value), so guard the cast — a
    single malformed attribute must not crash ingestion of the whole batch.

    Bounded by the same limit as the manual-usage path, and an over-bound value is
    dropped to 0 rather than clamped (see below): these values are summed into
    ``total_tokens`` (Int64) and priced into ``cost`` (Decimal(18,9)), so an
    unbounded per-field value overflows the column and ClickHouse rejects the
    whole insert — which on the public path discards every trace in the batch,
    not just this span. Negative counts are floored at 0 for the same reason the
    manual path floors them: they are meaningless as usage and would subtract
    from dashboard sums.
    """
    if value is None or value == "":
        return 0
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        logger.warning("Non-numeric OTEL token attribute %r; treating as 0", value)
        return 0
    if parsed < 0:
        logger.warning("Negative OTEL token attribute %r; treating as 0", value)
        return 0
    if parsed > _MAX_PLAUSIBLE_TOKENS:
        # Dropped, not clamped. Clamping substitutes an implausible count that is then
        # priced and stored, so one malformed span lands a trillion-token, nine-figure
        # row that dominates every cost and token aggregate it appears in. The
        # manual-usage path discards an over-bound field for the same reason, and every
        # other unusable value here already resolves to 0.
        logger.warning(
            "OTEL token attribute %r exceeds the plausible bound %d; treating as 0",
            value,
            _MAX_PLAUSIBLE_TOKENS,
        )
        return 0
    return parsed


def str_or_none(value: Any) -> str | None:
    """Coerce a present OTEL attribute to str for a String column; None stays None.

    Same hazard as ``str_attr``, one layer later: OTLP values are typed, so an
    ordinary sender can put an int in ``user.id`` or a bool in ``session.id``. Those
    reach ClickHouse columns typed ``Nullable(String)``, which rejects a non-string
    and fails the INSERT — and the insert carries the whole batch, so on the public
    path one such span discards every trace in the export after the route already
    returned 200. Coerce rather than drop: the value is still the caller's identifier,
    just wrongly typed on the wire.
    """
    if value is None or isinstance(value, str):
        return value
    return str(value)


def int32_or_none(value: Any) -> int | None:
    """Coerce a present OTEL attribute to an Int32-representable int; else None.

    Mirror of ``str_or_none`` for the ``Nullable(Int32)`` columns. An SDK is free to
    report a line number as a string, a float, or a value past the Int32 range, and
    any of those fails the INSERT for the whole batch. Out-of-range and unparseable
    values become None rather than being clamped: a wrong line number is worse than
    an absent one, since it points a reader at unrelated source.
    """
    # isinstance(True, int) is True and int(True) is 1, so an unguarded bool would
    # silently record line 1 -- the "points a reader at unrelated source" outcome
    # this helper drops out-of-range values to avoid.
    if value is None or value == "" or isinstance(value, bool):
        return None
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        logger.warning("Non-numeric OTEL Int32 attribute %r; dropping", value)
        return None
    if not (-(2**31) <= parsed < 2**31):
        logger.warning("OTEL Int32 attribute %r outside the column range; dropping", value)
        return None
    return parsed


def str_attr(value: Any) -> str:
    """Coerce a present OTEL attribute to str for case-folding; missing -> "".

    OTLP attribute values are typed — a sender may legitimately supply an int,
    bool, double or array for a key we expect to be a string. Guarding only for
    None (``attrs.get(k) or ""``) leaves ``.upper()``/``.lower()`` to raise
    AttributeError on those, which on the public path is fatal well past the
    point of no return: the route has already 200'd, so the whole S3 batch —
    every trace in that export, not just the offending span — is lost after the
    task's retries. Coerce instead; a wrong-typed value simply fails to match
    any known kind and falls through to the normal inference path.
    """
    if value is None:
        return ""
    return value if isinstance(value, str) else str(value)


# Fields recognized in the Python SDK's manual usage dict
# (``update_current_span(usage=...)``), serialized as JSON into the
# ``traceroot.llm.usage`` span attribute. The TypeScript SDK writes that blob too
# but with its own vocabulary (``input``/``output``/``cacheRead``), and its usage
# reaches us through the OpenInference ``llm.token_count.*`` attributes that
# ``applyUsage`` also stamps — so it takes the instrumentor path, not this one.
_MANUAL_USAGE_KEYS = (
    "input_tokens",
    "output_tokens",
    "cache_read_tokens",
    "cache_write_tokens",
    "cache_write_1h_tokens",
    "reasoning_tokens",
)


def parse_manual_usage(raw: Any) -> dict[str, int]:
    """Parse the manual usage dict reported via the SDKs' update-span API.

    The ``traceroot.llm.usage`` attribute is untrusted wire input: a non-JSON
    string, a non-dict payload, or a non-numeric, negative, non-finite or
    out-of-range field must never crash ingestion (``json.loads`` accepts literal
    ``Infinity``/``NaN``, and ``int(inf)`` raises OverflowError). Values are
    truncated toward zero. Unusable fields are dropped and
    counts are clamped non-negative, so a partially-malformed dict degrades to
    its valid fields (and an entirely unusable one to the text-estimation
    fallback), never to an error.

    Args:
        raw (Any): The raw attribute value (a JSON string as the SDK writes it,
            or an already-decoded dict).

    Returns:
        dict[str, int]: The recognized usage fields with non-negative int
            values; empty when the payload is missing or unusable.
    """
    if isinstance(raw, str):
        try:
            raw = json.loads(raw)
        # RecursionError: json.loads raises it on deeply-nested payloads, which
        # would otherwise fail the whole ingest task instead of this one attribute.
        except (TypeError, ValueError, RecursionError):
            logger.warning("Manual usage attribute is not valid JSON; ignoring it")
            return {}
    if not isinstance(raw, dict):
        if raw is not None:
            logger.warning("Manual usage attribute is not an object; ignoring it")
        return {}
    # Fields outside the recognized set are never examined below, so without this
    # they vanish without any signal at all — a provider token type we don't model
    # yet (audio, image, a new cache variant) reads as if it was never reported.
    # Bounded because the payload is client-controlled.
    unrecognized = sorted(k for k in raw if k not in _MANUAL_USAGE_KEYS)
    if unrecognized:
        logger.warning(
            "Manual usage fields %s are not recognized and were ignored; recognized fields are %s",
            unrecognized[:10],
            list(_MANUAL_USAGE_KEYS),
        )
    usage: dict[str, int] = {}
    for key in _MANUAL_USAGE_KEYS:
        value = raw.get(key)
        if value is None:
            continue
        # A dropped field is silent data loss from the user's point of view: they
        # reported a count and it is priced as if absent. Warn as int_or_zero does
        # for the same input class, so the discard is diagnosable from the logs.
        if isinstance(value, bool):
            logger.warning("Manual usage field %s is a bool (%r); ignoring it", key, value)
            continue
        try:
            parsed = max(int(value), 0)
        except (TypeError, ValueError, OverflowError):
            logger.warning(
                "Manual usage field %s is not a usable number (%r); ignoring it", key, value
            )
            continue
        if parsed > _MAX_PLAUSIBLE_TOKENS:
            logger.warning(
                "Manual usage field %s exceeds the sanity bound (%r); ignoring it", key, value
            )
            continue
        usage[key] = parsed
    return usage


def decode_otel_id(b64_value: str | None) -> str | None:
    """Decode base64-encoded OTEL trace/span ID to hex string.

    OTEL IDs are 16 bytes (trace_id) or 8 bytes (span_id), base64 encoded.
    We convert to hex for readability and storage.

    Args:
        b64_value: Base64-encoded ID string, or None

    Returns:
        Hex string representation, or None if input is None/empty or the ID is
        all zero bytes
    """
    if not b64_value:
        return None
    try:
        decoded = base64.b64decode(b64_value)
        hex_id = decoded.hex()
        # Some emitters send all-zero bytes for "no parent" instead of omitting
        # the field; the OTLP spec treats all-zero IDs as invalid/absent. Without
        # this, a zero-filled parent_span_id hides the root span (detection never
        # triggers) and reads as a permanently-dangling parent.
        if set(hex_id) == {"0"}:
            return None
        return hex_id
    except Exception as e:
        logger.warning(f"Failed to decode OTEL ID '{b64_value}': {e}")
        return b64_value  # Return as-is if decoding fails


def nanos_to_datetime(nanos: object) -> datetime | None:
    """Convert nanoseconds since epoch to datetime.

    Args:
        nanos: Unix timestamp in nanoseconds (int or string representation)

    Returns:
        datetime object, or None if input is None/empty/malformed
    """
    if nanos is None:
        return None
    # MessageToDict converts large ints to strings to preserve precision
    if isinstance(nanos, str):
        if not nanos:
            return None
        try:
            nanos = int(nanos)
        except ValueError:
            return None
    elif isinstance(nanos, bool) or not isinstance(nanos, int):
        return None

    # Convert nanos to seconds (float to preserve precision)
    try:
        seconds = nanos / 1_000_000_000
        return datetime.fromtimestamp(seconds, tz=UTC).replace(tzinfo=None)
    except (OverflowError, OSError, ValueError):
        return None


def extract_attribute_value(attr_value: dict) -> Any:
    """Extract the actual value from an OTEL attribute value wrapper.

    OTEL attributes have typed values like:
    {"stringValue": "hello"} or {"intValue": 42} or {"boolValue": true}

    Uses camelCase field names (standard OTLP JSON format).

    Args:
        attr_value: OTEL attribute value dict

    Returns:
        The unwrapped value
    """
    if "stringValue" in attr_value:
        return attr_value["stringValue"]
    elif "intValue" in attr_value:
        return int(attr_value["intValue"])
    elif "boolValue" in attr_value:
        return attr_value["boolValue"]
    elif "doubleValue" in attr_value:
        return attr_value["doubleValue"]
    elif "arrayValue" in attr_value:
        return [extract_attribute_value(v) for v in attr_value["arrayValue"].get("values", [])]
    elif "kvlistValue" in attr_value:
        return {
            kv["key"]: extract_attribute_value(kv["value"])
            for kv in attr_value["kvlistValue"].get("values", [])
        }
    else:
        return None


def attributes_to_dict(attributes: list[dict]) -> dict[str, Any]:
    """Convert OTEL attributes list to a simple dict.

    Args:
        attributes: List of {"key": "...", "value": {...}} dicts

    Returns:
        Simple dict mapping keys to values
    """
    result = {}
    for attr in attributes:
        key = attr.get("key", "")
        value = attr.get("value", {})
        result[key] = extract_attribute_value(value)
    return result


def get_span_kind(attrs: dict[str, Any], otel_kind: int | str | None) -> str:
    """Determine the span kind from span attributes.

    Uses traceroot.span.type attribute if present, otherwise infers from attributes.

    Args:
        attrs: Span attributes dict
        otel_kind: OTEL span kind (int or string like "SPAN_KIND_INTERNAL")

    Returns:
        One of: "LLM", "SPAN", "AGENT", "TOOL", "EVALUATION", "TASK", "SCORER"
    """
    # Check explicit type attribute (handle None values). EVALUATION_SPAN_KINDS is
    # included so the SDK's offline-evaluation spans are preserved rather than silently
    # coerced to SPAN. Preserving SCORER in particular is load-bearing beyond
    # classification: cost attribution walks the scorer subtree to keep judge cost out
    # of the candidate's cost.
    explicit_type = str_attr(attrs.get("traceroot.span.type")).upper()
    if (
        explicit_type in (SpanKind.LLM, SpanKind.SPAN, SpanKind.AGENT, SpanKind.TOOL)
        or explicit_type in EVALUATION_SPAN_KINDS
    ):
        return explicit_type

    # Check OpenInference semantic conventions (handle None values)
    openinference_type = str_attr(attrs.get("openinference.span.kind")).upper()
    if openinference_type == SpanKind.LLM:
        return SpanKind.LLM
    elif openinference_type == SpanKind.AGENT:
        return SpanKind.AGENT
    elif openinference_type == SpanKind.TOOL:
        return SpanKind.TOOL
    elif openinference_type == "CHAIN":
        return SpanKind.SPAN

    # GenAI semconv operation name (pydantic-ai, native OTel GenAI instrumentors)
    operation_name = str_attr(attrs.get("gen_ai.operation.name")).lower()
    if operation_name in ("chat", "text_completion", "embeddings"):
        return SpanKind.LLM
    if operation_name == "execute_tool":
        return SpanKind.TOOL
    # Agent-invocation roots carry gen_ai.request.model too; decide AGENT here
    # so the model fallback below cannot flip them to LLM.
    if operation_name == "invoke_agent":
        return SpanKind.AGENT

    # Infer from LLM-related attributes
    if (
        attrs.get("gen_ai.system")
        or attrs.get("gen_ai.request.model")
        or attrs.get("llm.model_name")
        or attrs.get("traceroot.llm.model")
    ):
        return SpanKind.LLM

    # Use `is not None` (not truthiness) so an empty-string value still classifies as TOOL
    if (
        attrs.get("gen_ai.tool.call.arguments") is not None
        or attrs.get("gen_ai.tool.call.result") is not None
    ):
        return SpanKind.TOOL

    return SpanKind.SPAN


def _extract_user_id(attrs: dict[str, Any]) -> str | None:
    """Extract user_id from span attributes, checking multiple keys."""
    return str_or_none(
        attrs.get("traceroot.trace.user_id") or attrs.get("user.id") or attrs.get("session.user_id")
    )


def _extract_session_id(attrs: dict[str, Any]) -> str | None:
    """Extract session_id from span attributes, checking multiple keys."""
    return str_or_none(attrs.get("traceroot.trace.session_id") or attrs.get("session.id"))


def transform_otel_to_clickhouse(
    otel_data: dict,
    project_id: str,
) -> tuple[list[dict], list[dict]]:
    """Transform OTEL JSON to ClickHouse traces and spans.

    Never sets `source` on a record. Classification belongs to the ingest route, not
    the payload: the internal route stamps 'detector' after this returns, and every
    other row is written as 'user' by the insert helpers (the column's DEFAULT is the
    backfill backstop for pre-migration rows, not the path live writes take). That makes the anti-spoof
    guarantee structural — a tenant-supplied traceroot.source is simply never read
    into a record, so there is no flag that could honor it by mistake.

    Do not reintroduce a "trust the payload marker" path for a new caller. `source` is a
    trust label with two readers: reads exclude non-'user' rows, and one endpoint selects
    them (the runs surface opens a self-trace by asking for source='detector'). A
    tenant-settable value would therefore not merely hide their traffic from their own
    lists — it would inject it into a surface presented as internal telemetry. Metering is
    unaffected either way, since it counts every stored row. A future internal emitter
    should be classified by its ingest route, as the detector one is, never by an attribute
    travelling in the payload.

    Args:
        otel_data: Parsed OTEL JSON data (camelCase format with resourceSpans)
        project_id: The project ID to associate with all records

    Returns:
        Tuple of (traces, spans) lists ready for ClickHouse insertion
    """
    traces: dict[str, dict] = {}  # trace_id -> trace record
    spans: list[dict] = []

    # Track user_id/session_id per trace, collected from ANY span
    # Priority: root span values > first child span values
    trace_attrs: dict[
        str, dict[str, str | None]
    ] = {}  # trace_id -> {"user_id": ..., "session_id": ...}

    # Best-known root name per trace: (ids_path_length, name).
    # Shortest ids_path = closest to root. Used to correct eager trace names
    # when the first span in a batch isn't the closest-to-root span for that trace.
    _trace_name_candidates: dict[str, tuple[int, str]] = {}
    trace_git_attrs: dict[str, dict[str, str | None]] = {}

    # Trace-level fields collected from ANY span in the batch and applied post-loop.
    # Both are attached to the shallow (eager) trace record as well as the root-upgraded
    # one: OTel's BatchSpanProcessor exports a span when it ENDS, so children routinely
    # export in an earlier batch than their parent and the root is usually the LAST span
    # of a trace to arrive. Reading these only off the root would leave every trace
    # unclassified until the root lands — and permanently unclassified if the process
    # dies first, a state nothing reconciles.
    _trace_is_evaluation: set[str] = set()  # any eval-kind span seen for this trace
    _trace_environment: dict[str, str] = {}  # first non-null environment seen

    # camelCase: resourceSpans
    resource_spans = otel_data.get("resourceSpans", [])

    for resource_span in resource_spans:
        # camelCase: scopeSpans
        scope_spans = resource_span.get("scopeSpans", [])

        for scope_span in scope_spans:
            otel_spans = scope_span.get("spans", [])
            scope_name = (scope_span.get("scope") or {}).get("name")

            for otel_span in otel_spans:
                # Decode IDs (camelCase: traceId, spanId, parentSpanId)
                trace_id = decode_otel_id(otel_span.get("traceId"))
                span_id = decode_otel_id(otel_span.get("spanId"))
                parent_span_id = decode_otel_id(otel_span.get("parentSpanId"))

                if not trace_id or not span_id:
                    logger.warning("Skipping span with missing traceId or spanId")
                    continue

                # Parse timestamps (camelCase: startTimeUnixNano, endTimeUnixNano)
                start_time = nanos_to_datetime(otel_span.get("startTimeUnixNano"))
                end_time = nanos_to_datetime(otel_span.get("endTimeUnixNano"))

                if not start_time:
                    logger.warning(f"Skipping span {span_id} with missing startTimeUnixNano")
                    continue

                # Parse attributes
                span_attrs = attributes_to_dict(otel_span.get("attributes", []))

                # Determine span kind
                otel_kind = otel_span.get("kind")
                span_kind = get_span_kind(span_attrs, otel_kind)

                # Extract span name; for tool spans prefer the actual tool name over
                # generic instrumentation names like "running tool" (pydantic-ai).
                span_name = otel_span.get("name", "unknown")
                if span_kind == SpanKind.TOOL:
                    tool_name = span_attrs.get("gen_ai.tool.name") or span_attrs.get("tool.name")
                    if tool_name:
                        # `name` is a non-nullable String on both spans and traces, and
                        # this is the one path that sources it from a caller attribute
                        # rather than the proto's own string field.
                        span_name = str_attr(tool_name)

                # Build span record.
                #
                # `environment` is the user's deployment tag (TRACEROOT_ENVIRONMENT:
                # production, staging, ...) and is passed through untouched. The
                # "this is an offline-evaluation run" classification is a SEPARATE
                # field, never folded into this one: `environment` is a user-namespace
                # value and a user-namespace value must not double as an internal
                # control flag. Overloading it would (a) misclassify a customer who
                # legitimately names their environment "evaluation", hiding their real
                # traces, and (b) silently fail to classify any eval run in a project
                # that sets TRACEROOT_ENVIRONMENT — the common case in CI or an
                # SDK-initialised app, since those spans already carry the attribute.
                #
                # The classification is derived from the span kind alone, which the
                # SDK's eval engine sets and the user cannot influence.
                environment = span_attrs.get("traceroot.environment")
                is_evaluation = span_kind in EVALUATION_SPAN_KINDS
                if is_evaluation:
                    _trace_is_evaluation.add(trace_id)
                if isinstance(environment, str):
                    _trace_environment.setdefault(trace_id, environment)
                span_record = {
                    "span_id": span_id,
                    "trace_id": trace_id,
                    "parent_span_id": parent_span_id,
                    "project_id": project_id,
                    "span_start_time": start_time,
                    "span_end_time": end_time,
                    "name": span_name,
                    "span_kind": span_kind,
                    "status": SpanStatus.OK,
                }
                if isinstance(environment, str):
                    span_record["environment"] = environment
                if is_evaluation:
                    span_record["is_evaluation"] = True

                # Extract git source fields for span
                git_source_file = str_or_none(span_attrs.get("traceroot.git.source_file"))
                # source_line lands in Nullable(Int32): parse it like any other numeric
                # attribute rather than passing a non-numeric string straight through.
                git_source_line = int32_or_none(span_attrs.get("traceroot.git.source_line"))
                git_source_function = str_or_none(span_attrs.get("traceroot.git.source_function"))
                if git_source_file is not None:
                    span_record["git_source_file"] = git_source_file
                if git_source_line is not None:
                    span_record["git_source_line"] = git_source_line
                if git_source_function is not None:
                    span_record["git_source_function"] = git_source_function

                # Extraction priority (first key present/not-None wins):
                # 1. TraceRoot SDK: user-provided explicit values — highest authority.
                # 2. OpenInference: normalized cross-framework schema (LLM/chain spans).
                # 3. GenAI semconv: native OTel GenAI attributes (LLM + tool spans).
                # 4. Framework-specific fallbacks: raw attrs before OpenInference normalization.
                #
                # Presence checks (`is not None`) rather than truthiness ensure that falsy
                # but valid values (e.g. empty string) do not fall through to lower-priority keys.
                span_input = first_present(
                    span_attrs,
                    [
                        "traceroot.span.input",  # 1. TraceRoot SDK explicit input
                        "input.value",  # 2. OpenInference normalized input (LLM/chain)
                        "tool.parameters",  # 2. OpenInference tool input (pydantic-ai tool_arguments mapped here)
                        "gen_ai.input.messages",  # 3. GenAI semconv LLM input messages
                        "gen_ai.tool.call.arguments",  # 3. GenAI semconv tool-call arguments
                        "tool_arguments",  # 4. Raw pydantic-ai/Logfire attr before OpenInference normalization
                    ],
                )
                span_output = first_present(
                    span_attrs,
                    [
                        "traceroot.span.output",  # 1. TraceRoot SDK explicit output
                        "output.value",  # 2. OpenInference normalized output (LLM/chain/tool)
                        "gen_ai.output.messages",  # 3. GenAI semconv LLM output messages
                        "gen_ai.tool.call.result",  # 3. GenAI semconv tool-call result
                        "tool_response",  # 4. Raw pydantic-ai/Logfire attr before OpenInference normalization
                    ],
                )

                if span_input is not None:
                    span_record["input"] = (
                        json.dumps(span_input) if not isinstance(span_input, str) else span_input
                    )
                if span_output is not None:
                    span_record["output"] = (
                        json.dumps(span_output) if not isinstance(span_output, str) else span_output
                    )

                # Model & token fields — extract API-provided counts whenever a model
                # name is present, not just for LLM spans. Auto-instrumentors
                # (OpenInference, GenAI) set model/token attrs on AGENT and CHAIN spans
                # too. Text-based ESTIMATION, however, is LLM-spans-only (see below).
                # Coerced before use, not just before storage: a non-string model
                # reaches `get_model_price`, whose catalog lookup is a regex match and
                # raises TypeError on a non-str — out of the per-span loop and out of
                # the whole transform, so the batch is lost before it ever reaches an
                # INSERT the column type could reject.
                model_name = str_or_none(
                    span_attrs.get("traceroot.llm.model")
                    or span_attrs.get("gen_ai.request.model")
                    or span_attrs.get("llm.model_name")
                )
                if model_name:
                    span_record["model_name"] = model_name

                    # Try API-provided token counts first (from instrumentors).
                    # OpenInference: llm.token_count.*  ·  GenAI semconv: gen_ai.usage.*
                    input_token_keys = [
                        "llm.token_count.prompt",
                        "gen_ai.usage.input_tokens",
                        "gen_ai.usage.prompt_tokens",
                    ]
                    output_token_keys = [
                        "llm.token_count.completion",
                        "gen_ai.usage.output_tokens",
                        "gen_ai.usage.completion_tokens",
                    ]
                    if span_kind == SpanKind.LLM:
                        # Vercel AI SDK raw GROSS totals are the only token source it
                        # normalizes to neither llm.* nor gen_ai.*, so we read them as
                        # a fallback. But they sit on BOTH the LLM doGenerate span AND
                        # its AGENT/CHAIN wrapper (ai.generateText/ai.generateObject),
                        # where they restate the SUM of the wrapper's LLM children.
                        # Trust them only on the LLM span itself — otherwise the
                        # wrapper is priced on top of its children (double count).
                        # generateObject emits only the legacy *Tokens spelling; its
                        # real usage still lands on an LLM .doGenerate child.
                        input_token_keys += ["ai.usage.inputTokens", "ai.usage.promptTokens"]
                        output_token_keys += ["ai.usage.outputTokens", "ai.usage.completionTokens"]
                    api_input_tokens = first_present_number(span_attrs, input_token_keys)
                    api_output_tokens = first_present_number(span_attrs, output_token_keys)
                    # Cache buckets. The OpenInference keys (prompt_details.*) are the
                    # verified path for Anthropic/OpenAI and MUST be listed first —
                    # they are the same family as llm.token_count.prompt (read above).
                    api_cache_read_tokens = first_present_number(
                        span_attrs,
                        [
                            "llm.token_count.prompt_details.cache_read",
                            "gen_ai.usage.cache_read.input_tokens",
                            "gen_ai.usage.cache_read_input_tokens",
                            "gen_ai.usage.input_cached_tokens",
                            "gen_ai.usage.details.cache_read_tokens",
                            # pydantic-ai version variants (names differ by release):
                            "gen_ai.usage.cache_read_tokens",
                            "gen_ai.usage.details.cache_read_input_tokens",
                            # Vercel AI SDK: cache detail is NEVER normalized to
                            # llm.*/gen_ai.* — it exists only under ai.usage.*:
                            "ai.usage.cachedInputTokens",
                            "ai.usage.inputTokenDetails.cacheReadTokens",
                        ],
                    )
                    api_cache_write_tokens = first_present_number(
                        span_attrs,
                        [
                            "llm.token_count.prompt_details.cache_write",
                            "gen_ai.usage.cache_creation.input_tokens",
                            "gen_ai.usage.cache_creation_input_tokens",
                            "gen_ai.usage.details.cache_write_tokens",
                            # pydantic-ai version variant:
                            "gen_ai.usage.details.cache_creation_input_tokens",
                            # Vercel AI SDK raw attr (never normalized upstream):
                            "ai.usage.inputTokenDetails.cacheWriteTokens",
                        ],
                    )
                    # Optional Anthropic 1-hour cache-write portion (1h write = 2.0x
                    # input, versus 1.25x for the default 5-minute write). A SUBSET of
                    # cache_write, priced at its own rate when present; absent for every
                    # emitter today (the split is dropped at the instrumentation layer),
                    # so this defaults to None -> 0 and leaves pricing unchanged.
                    api_cache_write_1h_tokens = first_present_number(
                        span_attrs,
                        [
                            "llm.token_count.prompt_details.cache_write_1h",
                            "gen_ai.usage.cache_creation.ephemeral_1h_input_tokens",
                            "gen_ai.usage.cache_creation_ephemeral_1h_input_tokens",
                        ],
                    )
                    # Reasoning tokens (o-series / GPT-5): a SUBSET of output
                    # tokens, already priced at the output rate, so this is
                    # display-only and must NOT feed the cost buckets.
                    api_reasoning_tokens = first_present(
                        span_attrs,
                        [
                            "llm.token_count.completion_details.reasoning",
                            "gen_ai.usage.reasoning_tokens",
                            "gen_ai.usage.output_details.reasoning_tokens",
                            "gen_ai.usage.details.reasoning_tokens",
                            # Vercel AI SDK raw attrs (aliases of the same value):
                            "ai.usage.outputTokenDetails.reasoningTokens",
                            "ai.usage.reasoningTokens",
                        ],
                    )

                    # Agent-invocation and step spans stamp aggregate
                    # gen_ai.usage.* totals restating the SUM of their LLM
                    # children — the same wrapper pattern as the raw ai.usage.*
                    # keys gated above, moved into the normalized namespace.
                    # Adopting them prices every token twice.
                    aggregate_wrapper = _span_aggregates_child_usage(
                        scope_name, span_kind, span_attrs
                    )

                    # Manual usage reported via the SDKs' update-span API
                    # (traceroot.llm.usage) — the documented token source for
                    # self-instrumented spans, where no instrumentor maps the
                    # provider response (custom clients, gateways, proxies).
                    # Instrumentor attributes win WHOLE-DICT, never per-field:
                    # merging could pair counts measured under different
                    # conventions (gross vs net input) and double-price cache.
                    # When the manual dict is used, it replaces every field, so
                    # the span is priced under the reporter's one convention.
                    # The aggregate check here is belt-and-braces, not load-bearing:
                    # the adoption branch below is gated on it too, so a wrapper's
                    # manual dict would be parsed and then discarded anyway. Keeping
                    # it states the invariant where the dict is read — manual usage
                    # must never resurrect counts on a span we suppressed — and skips
                    # a needless parse.
                    if (
                        not aggregate_wrapper
                        and api_input_tokens is None
                        and api_output_tokens is None
                    ):
                        manual_usage = parse_manual_usage(span_attrs.get("traceroot.llm.usage"))
                        if "input_tokens" in manual_usage or "output_tokens" in manual_usage:
                            api_input_tokens = manual_usage.get("input_tokens")
                            api_output_tokens = manual_usage.get("output_tokens")
                            api_cache_read_tokens = manual_usage.get("cache_read_tokens")
                            api_cache_write_tokens = manual_usage.get("cache_write_tokens")
                            api_cache_write_1h_tokens = manual_usage.get("cache_write_1h_tokens")
                            api_reasoning_tokens = manual_usage.get("reasoning_tokens")
                        elif manual_usage:
                            # Recognized fields, but nothing to price against: a
                            # cache or reasoning count alone does not describe a
                            # call. Dropping it silently is the same data loss the
                            # field-level warnings above exist to surface.
                            logger.warning(
                                "Manual usage reported only %s with no input_tokens or "
                                "output_tokens; ignoring it",
                                sorted(manual_usage),
                            )

                    if not aggregate_wrapper and (
                        api_input_tokens is not None or api_output_tokens is not None
                    ):
                        # Use API-provided counts (accurate).
                        input_tokens = int_or_zero(api_input_tokens)
                        output_tokens = int_or_zero(api_output_tokens)
                        span_record["output_tokens"] = output_tokens

                        # Normalize counts into disjoint buckets keyed on the
                        # instrumentation scope. The SAME buckets feed both the
                        # stored breakdown columns and the cost, so the displayed
                        # split always reconciles and matches what was priced (#958).
                        from worker.tokens.buckets import normalize_token_usage
                        from worker.tokens.pricing import (
                            cost_from_buckets,
                            get_model_price,
                        )

                        buckets = normalize_token_usage(
                            scope_name,
                            input_tokens=input_tokens,
                            output_tokens=output_tokens,
                            cache_read_tokens=int_or_zero(api_cache_read_tokens),
                            cache_write_tokens=int_or_zero(api_cache_write_tokens),
                            cache_write_1h_tokens=int_or_zero(api_cache_write_1h_tokens),
                        )
                        # Store a GROSS (cache-inclusive) input reconstructed from the
                        # disjoint buckets, so the input column always reconciles with
                        # its cache breakdown. Net/exclusive emitters (e.g.
                        # claude-agent-sdk) report only the non-cached tokens in
                        # llm.token_count.prompt with cache as separate additive
                        # buckets, so the reported input alone (e.g. 2) understates the
                        # true total; summing the buckets recovers it. Gross emitters
                        # are unchanged (cache is already a subset of the input).
                        gross_input = (
                            buckets.input_uncached + buckets.cache_read + buckets.cache_write
                        )
                        span_record["input_tokens"] = gross_input
                        span_record["total_tokens"] = gross_input + output_tokens
                        # Persist the breakdown as a generic usage_details map (one
                        # ClickHouse Map column rather than a column per dimension, so
                        # new provider token types need no migration). cache_read/
                        # cache_write come from the disjoint buckets; reasoning is a
                        # subset of output, capped to it so the output split reconciles.
                        span_record["usage_details"] = {
                            "cache_read_tokens": buckets.cache_read,
                            "cache_write_tokens": buckets.cache_write,
                            "reasoning_tokens": min(
                                int_or_zero(api_reasoning_tokens), output_tokens
                            ),
                        }
                        # Persist the 1-hour cache-write portion only when an emitter
                        # actually reports it, so spans with no 1-hour portion (every
                        # span today) keep an identical usage_details map. The read path
                        # defaults the missing key to 0.
                        if buckets.cache_write_1h:
                            span_record["usage_details"]["cache_write_1h_tokens"] = (
                                buckets.cache_write_1h
                            )
                        cost = cost_from_buckets(get_model_price(model_name), buckets)
                        if cost is not None:
                            span_record["cost"] = cost
                    elif (
                        not aggregate_wrapper
                        and span_kind == SpanKind.LLM
                        and not _scope_skips_text_token_estimation(scope_name)
                    ):
                        # Fall back to text-based estimation — only for LLM (completion)
                        # spans. Wrapper AGENT/CHAIN spans restate text their LLM children
                        # already account for (e.g. the Vercel AI SDK's ai.generateText
                        # wrapper carries a model name and the conversation text but no
                        # token counts), so estimating them double-counts the trace.
                        # Aggregate spans are excluded for the same reason and must be
                        # named explicitly: unlike AGENT/CHAIN wrappers they can be
                        # LLM-kind, so the kind check alone would let their conversation
                        # text be estimated into fabricated counts.
                        # Scopes in _SKIP_TEXT_TOKEN_ESTIMATION_SCOPES leave even their
                        # LLM spans deliberately unset and are skipped as well.
                        from worker.tokens import calculate_cost

                        usage = calculate_cost(
                            model=model_name,
                            input_text=span_record.get("input"),
                            output_text=span_record.get("output"),
                        )
                        if usage["input_tokens"] is not None:
                            span_record["input_tokens"] = usage["input_tokens"]
                        if usage["output_tokens"] is not None:
                            span_record["output_tokens"] = usage["output_tokens"]
                        if usage["total_tokens"] is not None:
                            span_record["total_tokens"] = usage["total_tokens"]
                        if usage["cost"] is not None:
                            span_record["cost"] = usage["cost"]

                # Extract metadata
                # Priority: explicit traceroot.span.metadata > remaining attributes.
                #
                # The span-path attributes are merged in EITHER way. They are how
                # the client rebuilds the tree of an in-flight trace, and the two
                # branches used to be exclusive: a span that set explicit metadata
                # had its paths dropped here and then rendered as an orphan while
                # its parent was still open. That hit exactly the spans users
                # annotate — usually leaves, whose long-lived parents are the ones
                # still in flight — so the paths ride along with user metadata.
                span_path_attrs = {
                    key: span_attrs[key]
                    for key in SPAN_TREE_ATTRIBUTES
                    if span_attrs.get(key) is not None
                }
                explicit_metadata = span_attrs.get("traceroot.span.metadata")
                if explicit_metadata is not None:
                    parsed_explicit = explicit_metadata
                    if isinstance(parsed_explicit, str):
                        try:
                            parsed_explicit = json.loads(parsed_explicit)
                        except (TypeError, ValueError):
                            parsed_explicit = None
                    if isinstance(parsed_explicit, dict):
                        span_record["metadata"] = json.dumps({**parsed_explicit, **span_path_attrs})
                    elif isinstance(explicit_metadata, str):
                        # Not a JSON object (free-text or a scalar): store it as
                        # given. Nothing to merge into, so this span has no paths.
                        span_record["metadata"] = explicit_metadata
                    else:
                        span_record["metadata"] = json.dumps(explicit_metadata)
                else:
                    # Collect non-internal attributes as metadata. The span-path
                    # attributes are not "known" (they have no dedicated column),
                    # so they already fall in here.
                    extra_attrs = {
                        k: v
                        for k, v in span_attrs.items()
                        if not _is_known_attribute(k) and v is not None
                    }
                    if extra_attrs:
                        span_record["metadata"] = json.dumps(extra_attrs)

                # Check span status for errors
                status = otel_span.get("status", {})
                status_code = status.get("code", 0)
                # Handle both int (0, 1, 2) and string ("STATUS_CODE_ERROR") formats
                if status_code == 2 or status_code == "STATUS_CODE_ERROR":
                    span_record["status"] = SpanStatus.ERROR
                    span_record["status_message"] = status.get("message")

                spans.append(span_record)

                # Collect user_id/session_id from ANY span (not just root)
                # Priority: root span values overwrite, child span values only set if empty
                span_user_id = _extract_user_id(span_attrs)
                span_session_id = _extract_session_id(span_attrs)
                span_git_ref = str_or_none(span_attrs.get("traceroot.git.ref"))
                span_git_repo = str_or_none(span_attrs.get("traceroot.git.repo"))

                if trace_id not in trace_attrs:
                    trace_attrs[trace_id] = {"user_id": None, "session_id": None}
                if trace_id not in trace_git_attrs:
                    trace_git_attrs[trace_id] = {"git_ref": None, "git_repo": None}

                if not parent_span_id:
                    # Root span: always use its values if present (overwrites child values)
                    trace_attrs[trace_id]["user_id"] = (
                        span_user_id or trace_attrs[trace_id]["user_id"]
                    )
                    trace_attrs[trace_id]["session_id"] = (
                        span_session_id or trace_attrs[trace_id]["session_id"]
                    )
                    trace_git_attrs[trace_id]["git_ref"] = (
                        span_git_ref or trace_git_attrs[trace_id]["git_ref"]
                    )
                    trace_git_attrs[trace_id]["git_repo"] = (
                        span_git_repo or trace_git_attrs[trace_id]["git_repo"]
                    )
                else:
                    # Child span: only set if not already set (first child wins)
                    trace_attrs[trace_id]["user_id"] = (
                        trace_attrs[trace_id]["user_id"] or span_user_id
                    )
                    trace_attrs[trace_id]["session_id"] = (
                        trace_attrs[trace_id]["session_id"] or span_session_id
                    )
                    trace_git_attrs[trace_id]["git_ref"] = (
                        trace_git_attrs[trace_id]["git_ref"] or span_git_ref
                    )
                    trace_git_attrs[trace_id]["git_repo"] = (
                        trace_git_attrs[trace_id]["git_repo"] or span_git_repo
                    )

                # Eager trace creation:
                # Create a "shallow" trace record on the FIRST span we see for
                # a trace_id, so it appears in the UI immediately. When the root
                # span arrives later, upgrade to a "full" trace with rich metadata.
                if trace_id not in traces:
                    # Shallow trace — minimal placeholder so the trace appears in the
                    # list immediately. The post-loop _trace_name_candidates correction
                    # always overwrites "name" with the authoritative value, so there
                    # is no need to compute path[0] here.
                    traces[trace_id] = {
                        "trace_id": trace_id,
                        "project_id": project_id,
                        "trace_start_time": start_time,
                        "name": span_name,
                        "user_id": trace_attrs[trace_id]["user_id"],
                        "session_id": trace_attrs[trace_id]["session_id"],
                    }
                    if trace_git_attrs[trace_id]["git_ref"] is not None:
                        traces[trace_id]["git_ref"] = trace_git_attrs[trace_id]["git_ref"]
                    if trace_git_attrs[trace_id]["git_repo"] is not None:
                        traces[trace_id]["git_repo"] = trace_git_attrs[trace_id]["git_repo"]

                # Track the best-known root name for this trace using the span
                # closest to the root (shortest ids_path). Batches may contain
                # spans out of depth order, so the first span processed might not
                # be the shallowest one.
                if not parent_span_id:
                    # Actual root span — definitive, depth 0.
                    _trace_name_candidates[trace_id] = (0, span_name)
                else:
                    span_path_c = span_attrs.get(SPAN_PATH)
                    ids_path_c = span_attrs.get(SPAN_IDS_PATH)
                    candidate_name = (
                        str_attr(span_path_c[0])
                        if isinstance(span_path_c, (list, tuple)) and span_path_c
                        else span_name
                    )
                    depth = len(ids_path_c) if isinstance(ids_path_c, (list, tuple)) else 1
                    existing = _trace_name_candidates.get(trace_id)
                    if existing is None or depth < existing[0]:
                        _trace_name_candidates[trace_id] = (depth, candidate_name)

                if not parent_span_id:
                    # Root span arrived — upgrade to full trace with rich metadata
                    traces[trace_id].update(
                        {
                            "trace_start_time": start_time,
                            "name": span_name,
                            "user_id": trace_attrs[trace_id]["user_id"],
                            "session_id": trace_attrs[trace_id]["session_id"],
                        }
                    )

                    if isinstance(environment, str):
                        traces[trace_id]["environment"] = environment
                    if trace_git_attrs[trace_id]["git_ref"] is not None:
                        traces[trace_id]["git_ref"] = trace_git_attrs[trace_id]["git_ref"]
                    if trace_git_attrs[trace_id]["git_repo"] is not None:
                        traces[trace_id]["git_repo"] = trace_git_attrs[trace_id]["git_repo"]

                    # Extract trace-level metadata
                    trace_metadata = span_attrs.get("traceroot.trace.metadata")
                    if trace_metadata is not None:
                        traces[trace_id]["metadata"] = (
                            json.dumps(trace_metadata)
                            if not isinstance(trace_metadata, str)
                            else trace_metadata
                        )

                    # Root span input/output becomes trace input/output
                    if span_input is not None:
                        traces[trace_id]["input"] = (
                            json.dumps(span_input)
                            if not isinstance(span_input, str)
                            else span_input
                        )
                    if span_output is not None:
                        traces[trace_id]["output"] = (
                            json.dumps(span_output)
                            if not isinstance(span_output, str)
                            else span_output
                        )

    # Correct eager trace names: the first span processed may not be the shallowest.
    # Apply the best candidate (shortest ids_path) found across all spans in this batch.
    for trace_id, (_, best_name) in _trace_name_candidates.items():
        if trace_id in traces:
            traces[trace_id]["name"] = best_name

    # Classify the trace from ANY eval-kind span in the batch, not just the root, so a
    # batch of {SCORER, TASK} whose EVALUATION root has not been exported yet still
    # writes a classified trace row. The trace record is then never less classified than
    # its own spans, and the flag only ever goes 0 -> 1.
    for trace_id in _trace_is_evaluation:
        if trace_id in traces:
            traces[trace_id]["is_evaluation"] = True

    # Same for the user's environment tag: the shallow record would otherwise carry no
    # environment until the root arrives. The root-upgrade block above already set it
    # authoritatively when the root IS in this batch, so only fill the gap here.
    for trace_id, env in _trace_environment.items():
        if trace_id in traces and not traces[trace_id].get("environment"):
            traces[trace_id]["environment"] = env

    # Update trace records with user_id/session_id collected from child spans
    # (in case child spans with these attrs came after the root span was processed)
    # Update trace records with user_id/session_id collected from child spans (in
    # case child spans with these attrs came after the root span was processed).
    for trace_id, attrs in trace_attrs.items():
        if trace_id in traces:
            if attrs["user_id"] and not traces[trace_id].get("user_id"):
                traces[trace_id]["user_id"] = attrs["user_id"]
            if attrs["session_id"] and not traces[trace_id].get("session_id"):
                traces[trace_id]["session_id"] = attrs["session_id"]

    # Git repo/ref are stamped on every SDK span, but the root span often arrives
    # last in live streaming. Promote the first child values so repo/ref are visible
    # while the trace is still running, then let root values overwrite when present.
    for trace_id, attrs in trace_git_attrs.items():
        if trace_id in traces:
            if attrs["git_ref"] is not None:
                traces[trace_id]["git_ref"] = attrs["git_ref"]
            if attrs["git_repo"] is not None:
                traces[trace_id]["git_repo"] = attrs["git_repo"]

    return list(traces.values()), spans
