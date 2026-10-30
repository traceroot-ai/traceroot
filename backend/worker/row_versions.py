"""Versions for the span and trace rows an ingest batch writes.

Spans and traces are ReplacingMergeTree(ch_update_time) tables: of the rows that
share a key, the one with the latest ``ch_update_time`` is the one merges, FINAL
and the readers' ``ORDER BY ch_update_time DESC LIMIT 1 BY`` keep. Versioning a
batch's rows by when the API received it makes the most recently sent version of
a span win, even when an older batch is processed after a newer one (a retry, or
two workers racing).
"""

from datetime import UTC, datetime

#: Sorts below every receive time, so any trace row from a batch that carries the
#: trace's root span replaces a placeholder.
PLACEHOLDER_TRACE_VERSION = datetime(1970, 1, 1, tzinfo=UTC)


def receive_time(received_at: str | None) -> datetime | None:
    """Parse the receive time a task was queued with.

    Args:
        received_at (str | None): ISO-8601 time the API received the batch, or
            None for a task queued without one.

    Returns:
        datetime | None: The receive time, or None so the insert falls back to
            the insert time.
    """
    return datetime.fromisoformat(received_at) if received_at else None


def version_trace_rows(traces: list[dict], root_trace_ids: set[str]) -> list[dict]:
    """Version the placeholder rows among a batch's trace records below every real one.

    A trace row from a batch without the trace's root span is a placeholder: the
    ingest task writes it only for a trace that has no row yet, so the trace lists
    before its root arrives. A row from a root-bearing batch must replace it
    whichever is processed first. Receive times cannot promise that, since the
    root can arrive before a late child batch, so placeholders are versioned at
    ``PLACEHOLDER_TRACE_VERSION`` instead.

    Args:
        traces (list[dict]): The batch's trace records, updated in place.
        root_trace_ids (set[str]): Traces whose root span is in this batch.

    Returns:
        list[dict]: ``traces``, for use inline.
    """
    for trace in traces:
        if trace["trace_id"] not in root_trace_ids:
            trace["ch_update_time"] = PLACEHOLDER_TRACE_VERSION
    return traces
