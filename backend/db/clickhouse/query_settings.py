"""Per-query execution bounds shared by every ClickHouse read path.

One definition of "how a read may execute", so no read surface can end up less
bounded than its siblings. These are the ``settings`` channel documented on
``ClickHouseClient.query`` — server-side execution policy for a single query,
never data — and they are deliberately separate from the SQL each caller
compiles.

Every read behind an interactive surface is the same shape: a project-scoped,
time-windowed scan or GROUP BY answering a UI control or list. There is no
reason for two of them to expire or spill at different points, so they share
one mapping rather than each carrying its own copy.
"""

from types import MappingProxyType
from typing import Any

# A read that is slow is already useless to the surface waiting on it, so cap
# the scan rather than hold a worker on it. The server aborts at ~this many
# seconds (checked at data-processing checkpoints, not a hard wall-clock kill)
# with TIMEOUT_EXCEEDED, which surfaces to the caller as a raised exception.
# Short-lived caches in front of these reads do not protect the FIRST caller,
# which is the one this bounds.
QUERY_TIMEOUT_S = 10

# Aggregation memory ceiling before the GROUP BY spills to disk: past this the
# server writes intermediate state out instead of ballooning its own memory.
# Slower beats OOM. It matters most where one source row fans out before the
# aggregation sees it — metadata key discovery arrayJoins over mapKeys, and the
# trace list's keyed-metadata predicate reads the base table because
# metadata_map is deliberately absent from the spans no-I/O projection.
GROUP_BY_SPILL_BYTES = 1 * 1024**3

# Read-only mapping so a caller cannot mutate the shared bounds for every other
# read path by editing what it was handed. clickhouse-connect only iterates and
# copies ``settings``, so it consumes a MappingProxyType exactly as it does a
# dict.
#
#   readonly: a read only ever reads; saying so removes the whole class of
#     write/DDL statements from what these code paths could express.
#   max_execution_time / max_bytes_before_external_group_by: see the constants
#     above.
#
# use_query_condition_cache would additionally help the repeated same-window
# scans these surfaces issue, but it needs ClickHouse >= 25.4 — the current
# server rejects it as an unknown setting, so it is not in the mapping yet.
READ_QUERY_SETTINGS: MappingProxyType[str, Any] = MappingProxyType(
    {
        "readonly": 1,
        "max_execution_time": QUERY_TIMEOUT_S,
        "max_bytes_before_external_group_by": GROUP_BY_SPILL_BYTES,
    }
)
