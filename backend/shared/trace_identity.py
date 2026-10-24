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


# DateTime64(3) values used by TraceRoot are in the first few trillion
# milliseconds after the epoch.  Keeping the low 62 bits as an inverted start
# time makes an earlier competing remote entry the deterministic winner while
# the high two bits make ROOT > REMOTE_PARENT > PLACEHOLDER.
_MAX_START_MILLIS = (1 << 61) - 1


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
    normalized_start = (
        start_time.replace(tzinfo=UTC) if start_time.tzinfo is None else start_time.astimezone(UTC)
    )
    start_millis = int(normalized_start.timestamp() * 1000)
    start_millis = max(0, min(start_millis, _MAX_START_MILLIS))
    return (int(kind) << 62) | ((_MAX_START_MILLIS - start_millis) << 1) | int(is_evaluation)


def root_kind_name(root_kind: int | TraceRootKind) -> str:
    """Return the ClickHouse Enum8 label for a root kind."""

    return TraceRootKind(int(root_kind)).name.lower()
