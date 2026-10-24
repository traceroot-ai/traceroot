"""Deterministic identity and precedence for a stored trace row.

Trace rows are replacement records, not partial updates.  The version therefore
has to describe the logical winner, rather than the arrival time of the batch
that happened to write it.
"""

from __future__ import annotations

from datetime import UTC, datetime
from enum import IntEnum


class TraceRootKind(IntEnum):
    """Which span established the trace row's identity."""

    PLACEHOLDER = 0
    REMOTE_PARENT = 1
    ROOT = 2


# Keep a rank for migrated rows whose historical root kind is ambiguous.  They
# are not promoted to ``root_kind = root``; the intermediate rank only prevents
# a newly classified remote entry from replacing an already-established legacy
# identity.  A newly observed true root still wins.
_ROOT_RANK = {
    TraceRootKind.PLACEHOLDER: 0,
    TraceRootKind.REMOTE_PARENT: 2,
    TraceRootKind.ROOT: 6,
}
_LEGACY_RANK = 4

# Three rank bits leave 61 bits below them.  One bit is reserved for the
# monotonic evaluation flag, leaving 60 bits for inverted millisecond time —
# many millions of years of range for DateTime64(3) values.
_MAX_START_MILLIS = (1 << 60) - 1


def _version(rank: int, start_time: datetime | None, is_evaluation: bool) -> int:
    if start_time is None:
        return 0
    normalized_start = (
        start_time.replace(tzinfo=UTC) if start_time.tzinfo is None else start_time.astimezone(UTC)
    )
    start_millis = int(normalized_start.timestamp() * 1000)
    start_millis = max(0, min(start_millis, _MAX_START_MILLIS))
    return (rank << 61) | ((_MAX_START_MILLIS - start_millis) << 1) | int(is_evaluation)


def trace_root_version(
    root_kind: int | TraceRootKind,
    start_time: datetime | None,
    is_evaluation: bool = False,
) -> int:
    """Return the ReplacingMergeTree version for a trace identity.

    A missing start time cannot establish an identity and receives the
    placeholder version.  The result is stable across retries and independent
    of ClickHouse part/insert order.
    """

    kind = TraceRootKind(int(root_kind))
    if kind is TraceRootKind.PLACEHOLDER or start_time is None:
        return 0
    return _version(_ROOT_RANK[kind], start_time, is_evaluation)


def legacy_trace_version(start_time: datetime | None, is_evaluation: bool = False) -> int:
    """Version for an old established row whose exact root kind is unknowable.

    Migration 017 keeps ``root_kind`` as ``placeholder`` for these rows, but
    gives rows that match a persisted parentless span an intermediate logical
    rank.  This preserves the old identity against a later remote entry without
    claiming that the historical row was definitely a local root.
    """

    return _version(_LEGACY_RANK, start_time, is_evaluation)


def root_kind_name(root_kind: int | TraceRootKind) -> str:
    """Return the ClickHouse Enum8 label for a root kind."""

    return TraceRootKind(int(root_kind)).name.lower()
