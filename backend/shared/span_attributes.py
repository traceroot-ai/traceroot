"""SDK span-path attribute names.

These are wire-protocol strings emitted by the SDKs (`traceroot-py`
`transport/span_processor.py`, `traceroot-ts` `processor.ts` and the Mastra
exporter) and consumed by the dashboard to repair live span trees: while a
trace is in flight, children arrive before their parents (spans are exported
only when they end), and these attributes let the client synthesize the missing
ancestors instead of pinning their children to the root as orphans.

They reach the client through the span `metadata` column: the worker's
`_KNOWN_ATTRIBUTE_PREFIXES` deliberately does NOT cover them, so they fall
through to the leftover-attribute bag that becomes `metadata` (see
`worker/otel_transform.py`). Renaming one — or adding it to that prefix set —
silently disables live-tree repair, so both sides reference these constants
rather than the literals.
"""

SPAN_PATH = "traceroot.span.path"
"""Ancestor span names, root -> current span (inclusive)."""

SPAN_IDS_PATH = "traceroot.span.ids_path"
"""Ancestor span IDs, root -> direct parent (exclusive of the current span)."""

SPAN_STARTS_PATH = "traceroot.span.starts_path"
"""Ancestor start times as epoch-nanosecond decimal strings, aligned with SPAN_IDS_PATH.

Both SDKs emit it and ingest preserves it, so it reaches the client on the live
stream. Nothing reads it yet: a synthesized ancestor currently borrows the start
time of the first child that referenced it, which is always later than the real
one. The change that puts it to use (true placeholder starts) also adds it to
the trace-detail read, so it works on a page reload and not only live.
"""

SPAN_TREE_ATTRIBUTES = (SPAN_PATH, SPAN_IDS_PATH, SPAN_STARTS_PATH)
"""Everything the SDKs emit here — the set ingest must preserve into `metadata`.

Not the same as what the trace-detail read returns: that returns only the
attributes the client actually consumes.
"""
