"""Keep a group's id across fits by matching the new clusters to the old groups
through the traces they share.

Names and ids belong to the group, not to a fit: a filter or a trend line that
points at a group id must still mean the same set of traces after a refit.
"""

from __future__ import annotations

import uuid
from collections.abc import Mapping

# A new cluster inherits an old group's id when the traces they share are at least
# this share of the old group's members, or of the new cluster's members that
# existed at the previous fit.
MIN_SHARED_SHARE = 0.5
# ...and at least this many traces, so two tiny groups sharing one trace never match.
MIN_SHARED_COUNT = 3


def new_group_id() -> str:
    return f"g_{uuid.uuid4().hex[:12]}"


def match_groups(
    old: Mapping[str, set[str]],
    new: Mapping[int, set[str]],
    known_before: set[str],
) -> dict[int, str | None]:
    """Decide which old group each new cluster continues.

    Args:
        old: Previous fit's members, per old group id.
        new: This fit's members, per new cluster label.
        known_before: Every trace that had a placement at the previous fit
            (grouped or not). New clusters are judged on these only, so traces
            that arrived since do not dilute a match.

    Returns:
        dict[int, str | None]: For each new label, the old group id it continues,
            or None for a new group. Each old id is used at most once.
    """
    pairs: list[tuple[int, str, int]] = []
    for label, members in new.items():
        for gid, old_members in old.items():
            shared = len(members & old_members)
            if shared >= MIN_SHARED_COUNT:
                pairs.append((shared, gid, label))
    # Largest overlap first; ties broken by ids so the result is deterministic.
    pairs.sort(key=lambda p: (-p[0], p[1], p[2]))

    result: dict[int, str | None] = {label: None for label in new}
    used: set[str] = set()
    for shared, gid, label in pairs:
        if result[label] is not None or gid in used:
            continue
        known = len(new[label] & known_before)
        if shared / len(old[gid]) >= MIN_SHARED_SHARE or (
            known and shared / known >= MIN_SHARED_SHARE
        ):
            result[label] = gid
            used.add(gid)
    return result
