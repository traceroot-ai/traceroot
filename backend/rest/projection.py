"""Field-group projection for trace reads (a ``fields`` query parameter).

A single ``fields`` query parameter controls how much of a trace/span payload
comes back, instead of a pile of orthogonal ``include_x`` booleans or a hard
split into two differently-named endpoints. Named groups:

  ``core``      span tree + timing + status — always included.
  ``usage``     token counts + cost breakdown — small, included by default.
  ``io``        per-span ``input``/``output`` blobs — heavy, opt-in.
  ``metadata``  per-span ``metadata`` blob — heavy-ish, opt-in.

The two convenience aliases ``skeleton`` (``core,usage``) and ``full``
(everything) map to the obvious group sets. The dashboard/UI uses the
``skeleton`` default (the #1040 lightweight read, kept for payload size); export
and the agent request ``full`` for full fidelity.

Only the ``io``/``metadata`` groups require the extra bulk span-I/O ClickHouse
query, and only for the columns they name (``io_columns``) — ``core``/``usage``
are served entirely by the cheap skeleton read, so the default projection has no
query-cost regression for the dashboard.

Finer-grained ``io.input`` / ``io.output`` projection is a deliberate follow-up
(see the trace-read-projection epic); today ``io`` covers input+output together.
"""

CORE = "core"
USAGE = "usage"
IO = "io"
METADATA = "metadata"

# The canonical groups a *resolved* projection may contain.
_CANONICAL = frozenset({CORE, USAGE, IO, METADATA})

# Alias tokens a client may type, expanded into canonical group sets.
SKELETON = frozenset({CORE, USAGE})
FULL = frozenset({CORE, USAGE, IO, METADATA})
_ALIASES = {"skeleton": SKELETON, "full": FULL}

# Every token a `fields` value may legally contain (for the 400 message).
_VALID_TOKENS = sorted(set(_CANONICAL) | set(_ALIASES))

# Documentation string reused by every endpoint exposing ``fields``.
FIELDS_PARAM_DESC = (
    "Comma-separated field groups to include: 'core' (tree/timing/status, always "
    "included), 'usage' (tokens/cost), 'io' (per-span input/output), 'metadata' "
    "(per-span metadata). Aliases: 'skeleton' (core,usage), 'full' (everything). "
    "Unknown groups return 400."
)


class InvalidFieldsError(ValueError):
    """Raised when a ``fields`` value contains an unrecognized group token.

    A ``ValueError`` subclass so callers can map it to ``400 Bad Request``
    without importing FastAPI here.
    """


def resolve_span_fields(fields: str | None, *, default: frozenset[str]) -> frozenset[str]:
    """Parse a ``fields`` query value into a validated, canonical group set.

    ``None``/empty -> ``default``. Otherwise a comma-separated list of group
    names (``core``/``usage``/``io``/``metadata``) or the ``skeleton``/``full``
    aliases, case-insensitive. ``core`` is always implied so the span tree is
    never empty. An unrecognized token raises ``InvalidFieldsError`` (mapped to
    400) rather than being silently ignored — this catches client typos instead
    of quietly returning a narrower payload.
    """
    if not fields or not fields.strip():
        return default

    resolved: set[str] = set()
    unknown: list[str] = []
    for raw in fields.split(","):
        token = raw.strip().lower()
        if not token:
            continue
        if token in _ALIASES:
            resolved |= _ALIASES[token]
        elif token in _CANONICAL:
            resolved.add(token)
        else:
            unknown.append(raw.strip())

    if unknown:
        raise InvalidFieldsError(
            f"Unknown fields group(s): {', '.join(unknown)}. "
            f"Valid groups: {', '.join(_VALID_TOKENS)}."
        )

    resolved.add(CORE)
    return frozenset(resolved)


def io_columns(groups: frozenset[str]) -> frozenset[str]:
    """The set of blob columns (``input``/``output``/``metadata``) a projection needs.

    ``io`` -> input+output, ``metadata`` -> metadata. Empty when the projection
    is ``core``/``usage`` only — the signal the routers use to skip the bulk
    span-I/O query entirely (no dashboard regression).
    """
    columns: set[str] = set()
    if IO in groups:
        columns |= {"input", "output"}
    if METADATA in groups:
        columns.add("metadata")
    return frozenset(columns)


def merge_span_io(trace: dict, span_io: dict[str, dict]) -> None:
    """Attach bulk per-span I/O onto a trace's skeleton spans, in place.

    ``span_io`` is the ``{span_id: {column: value}}`` map from
    ``TraceReaderService.get_trace_spans_io`` — it already contains only the
    columns the projection requested, so each span is updated with exactly those
    keys. Spans absent from the map are left untouched (their I/O stays ``None``),
    so a partial/empty map never breaks serialization. Lives here (not in a router
    module) so both the public and internal trace endpoints share it without
    cross-importing.
    """
    for span in trace.get("spans", []):
        io = span_io.get(span["span_id"])
        if io:
            span.update(io)
