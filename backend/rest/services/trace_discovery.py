"""Option discovery for the filter UI: the distinct values a column takes.

Every read here answers "what could the user pick?", never "what matches?". Suggestion is
not permission — a value that falls outside an answer here stays filterable.
"""

import time
from datetime import datetime

from db.clickhouse import get_clickhouse_client
from db.clickhouse.query_settings import READ_QUERY_SETTINGS
from rest.services.trace_reader import customer_traffic_only, default_lookback_start
from rest.sql_utils import to_utc_naive

# Every discovery answer: cap the option list and cache briefly. A picker only needs the
# frequent entries, and the GROUP BY over spans is the heavy part. The cap bounds each
# option list; the cache bounds all of them together, since they share one dict keyed by
# namespace.
DISCOVERY_LIMIT = 100
DISCOVERY_CACHE_TTL_SECONDS = 30
DISCOVERY_CACHE_MAX = 256

# Execution bounds come from db.clickhouse.query_settings (READ_QUERY_SETTINGS), shared
# with the trace list and the widget queries: the same ClickHouse, the same kind of
# interactive, time-windowed GROUP BY behind a UI control, so there is no reason for them
# to expire or spill at different points. The rationale for each setting lives in that
# module. Note for this module in particular: the 30s discovery cache does not protect the
# FIRST caller, which is the one max_execution_time bounds.


def _floor_minute(dt: datetime | None) -> datetime | None:
    """Truncate a datetime to the whole minute (for the discovery cache key)."""
    return dt.replace(second=0, microsecond=0) if dt is not None else None


def _discovery_cache_key(
    namespace: str,
    project_id: str,
    subject: str,
    normalized_start: datetime,
    normalized_end: datetime | None,
) -> tuple:
    """Cache key for one discovery answer.

    Quantized to whole minutes so per-render jitter in the window bounds (the UI
    recomputes "now - duration" every render) can't bypass the cache and force a fresh
    full-project GROUP BY on every open.

    Args:
        namespace (str): Which discovery answer space the key belongs to — the scanned
            table for a column enumeration. Two answers can only collide if they share
            this.
        project_id (str): Project the answer is scoped to.
        subject (str): What was enumerated within the namespace — a registry-resolved
            column name.
        normalized_start (datetime): Naive-UTC lower window bound.
        normalized_end (datetime | None): Naive-UTC upper window bound, or ``None``.

    Returns:
        tuple: The cache key.
    """
    return (
        namespace,
        project_id,
        subject,
        _floor_minute(normalized_start),
        _floor_minute(normalized_end),
    )


def _resolve_scan_window(
    start_after: datetime | None,
    end_before: datetime | None,
) -> tuple[datetime, datetime | None]:
    """Normalize a discovery window to the bounds the scan will really use.

    Every discovery query resolves its window through here, so none of them can drift into
    a different default or a different notion of "open-ended".

    Args:
        start_after (datetime | None): Requested lower bound on the scanned table's time
            column, or ``None`` for an open-ended window.
        end_before (datetime | None): Requested upper bound (exclusive), or ``None``.

    Returns:
        tuple[datetime, datetime | None]: Naive-UTC ``(lower, upper)`` bounds. The lower
        bound is never ``None``; the upper bound stays ``None`` when open-ended.
    """
    normalized_start = to_utc_naive(start_after) if start_after is not None else None
    normalized_end = to_utc_naive(end_before) if end_before is not None else None
    # Never scan spans unbounded (the OOM class the filtered list guards against): the UI
    # always sends a window, this bounds a direct API caller that omits one.
    if normalized_start is None:
        normalized_start = default_lookback_start(normalized_end)
    return normalized_start, normalized_end


def _window_scan(
    time_column: str,
    project_id: str,
    normalized_start: datetime,
    normalized_end: datetime | None,
) -> tuple[str, dict]:
    """WHERE clause + bound parameters for a self-contained, project-scoped discovery scan.

    The window is applied at BOTH ends here: a discovery scan stands alone, with no
    trace-level semi-join above it to re-filter what it admits, so it must not offer options
    from outside the active window. Shared by every discovery query so no surface can
    quietly widen its own window or drop the customer-traffic restriction.

    Args:
        time_column (str): The scanned table's time column to bound (``span_start_time`` or
            ``trace_start_time``). A literal chosen by the caller, never user input — it is
            interpolated because column names cannot be bound as query parameters.
        project_id (str): Project that scopes the scan (tenant isolation).
        normalized_start (datetime): Naive-UTC lower bound on ``time_column``.
        normalized_end (datetime | None): Naive-UTC exclusive upper bound, or ``None``.

    Returns:
        tuple[str, dict]: The AND-joined WHERE clause and the parameters it binds.
    """
    params: dict = {"project_id": project_id, "start_after": normalized_start}
    # Exact bound, no lookback back-off: with no trace-level semi-join above it, the
    # boundary-drift reasoning behind SPAN_TIME_BOUND_LOOKBACK_HOURS doesn't apply here.
    # Detector self-traces are excluded because a suggestion list is customer-facing.
    conditions = [
        "project_id = {project_id:String}",
        customer_traffic_only(),
        f"{time_column} >= {{start_after:DateTime64(3)}}",
    ]
    if normalized_end is not None:
        conditions.append(f"{time_column} < {{end_before:DateTime64(3)}}")
        params["end_before"] = normalized_end
    return " AND ".join(conditions), params


class TraceDiscoveryService:
    """Enumerate the filter UI's options from ClickHouse, behind a short-lived cache."""

    def __init__(self):
        self._client = get_clickhouse_client()
        # Per-(namespace, project, subject, window) cache of discovery answers:
        # key -> (expiry, rows).
        self._discovery_cache: dict[tuple, tuple[float, list[dict]]] = {}

    def _cache_get(self, cache_key: tuple) -> list[dict] | None:
        """Return the unexpired cached rows for a discovery key, or ``None``.

        Args:
            cache_key (tuple): Key from ``_discovery_cache_key``.

        Returns:
            list[dict] | None: The cached rows, or ``None`` on a miss or an expired entry.
        """
        cached = self._discovery_cache.get(cache_key)
        # Monotonic, like the other in-process TTL caches (trace_reader): a wall-clock step
        # (NTP, DST-free but still steppable) must not expire or extend an entry.
        if cached is not None and cached[0] > time.monotonic():
            return cached[1]
        return None

    def _cache_put(self, cache_key: tuple, rows: list[dict]) -> None:
        """Cache one discovery answer, keeping the cache size bounded.

        Args:
            cache_key (tuple): Key from ``_discovery_cache_key``.
            rows (list[dict]): The rows to serve for the TTL.
        """
        now = time.monotonic()
        self._discovery_cache = {k: v for k, v in self._discovery_cache.items() if v[0] > now}
        if len(self._discovery_cache) >= DISCOVERY_CACHE_MAX:
            self._discovery_cache.pop(next(iter(self._discovery_cache)))
        self._discovery_cache[cache_key] = (now + DISCOVERY_CACHE_TTL_SECONDS, rows)

    def get_distinct_span_values(
        self,
        project_id: str,
        column: str,
        start_after: datetime | None = None,
        end_before: datetime | None = None,
    ) -> list[dict]:
        """Distinct values of a span column within the active window, by frequency.

        Powers the filter dropdown's categorical options (model, environment) and
        the widget builder's spans-view value dropdowns. Time-bounded and briefly
        cached so repeatedly opening the same filter does not re-scan spans.

        Args:
            project_id (str): Project that scopes the span scan (tenant isolation).
            column (str): A spans column name. MUST be a registry-resolved identifier,
                never raw user input — it is interpolated into the SQL because column
                names cannot be bound as query parameters.
            start_after (datetime | None): Lower bound on ``span_start_time``; prunes
                monthly partitions. ``None`` defaults to a fixed lookback rather than
                scanning all time.
            end_before (datetime | None): Upper bound on ``span_start_time`` (exclusive),
                symmetric with the trace list's window so the dropdown never offers
                values from traces newer than the active window's end.

        Returns:
            list[dict]: ``[{"value": str, "count": int}]`` ordered by descending
            frequency, capped at ``DISCOVERY_LIMIT``.
        """
        return self._distinct_values(
            table="spans",
            time_column="span_start_time",
            dedup_keys="project_id, trace_id, span_id",
            project_id=project_id,
            column=column,
            start_after=start_after,
            end_before=end_before,
        )

    def get_distinct_trace_values(
        self,
        project_id: str,
        column: str,
        start_after: datetime | None = None,
        end_before: datetime | None = None,
    ) -> list[dict]:
        """Distinct values of a traces column within the active window, by frequency.

        The traces-table sibling of ``get_distinct_span_values`` — powers the widget
        builder's traces-view value dropdowns (trace name, user, session, environment).

        Args:
            project_id (str): Project that scopes the trace scan (tenant isolation).
            column (str): A traces column name. MUST be a registry-resolved identifier,
                never raw user input — it is interpolated into the SQL because column
                names cannot be bound as query parameters.
            start_after (datetime | None): Lower bound on ``trace_start_time``; prunes
                monthly partitions. ``None`` defaults a lookback (never all-time).
            end_before (datetime | None): Upper bound on ``trace_start_time``
                (exclusive), symmetric with the widget query window.

        Returns:
            list[dict]: ``[{"value": str, "count": int}]`` ordered by descending
            frequency, capped at ``DISCOVERY_LIMIT``.
        """
        return self._distinct_values(
            table="traces",
            time_column="trace_start_time",
            dedup_keys="project_id, trace_id",
            project_id=project_id,
            column=column,
            start_after=start_after,
            end_before=end_before,
        )

    def _distinct_values(
        self,
        table: str,
        time_column: str,
        dedup_keys: str,
        project_id: str,
        column: str,
        start_after: datetime | None,
        end_before: datetime | None,
    ) -> list[dict]:
        """Shared distinct-values scan: dedup, group, count, cache.

        Window resolution and the scan's WHERE clause come from ``_resolve_scan_window``
        and ``_window_scan``, shared by every discovery query.

        Args:
            table (str): Source table (``spans`` or ``traces``) — a literal chosen by
                the public wrappers, never user input.
            time_column (str): The table's partition/time column the window bounds.
            dedup_keys (str): ``LIMIT 1 BY`` key list that identifies one logical row
                in the table's ReplacingMergeTree.
            project_id (str): Project that scopes the scan (tenant isolation).
            column (str): Registry-resolved column to enumerate (interpolated; column
                names cannot be bound as query parameters).
            start_after (datetime | None): Lower window bound on ``time_column``.
            end_before (datetime | None): Upper window bound on ``time_column``.

        Returns:
            list[dict]: ``[{"value": str, "count": int}]`` by descending frequency.
        """
        normalized_start, normalized_end = _resolve_scan_window(start_after, end_before)
        cache_key = _discovery_cache_key(
            table, project_id, column, normalized_start, normalized_end
        )
        cached = self._cache_get(cache_key)
        if cached is not None:
            return cached

        inner_where, params = _window_scan(
            time_column, project_id, normalized_start, normalized_end
        )

        # Dedup ReplacingMergeTree rows to the latest version per logical row BEFORE
        # counting, so a since-updated row can't inflate a value's count or surface a stale
        # value.
        query = f"""
            SELECT value, count() AS n
            FROM (
                SELECT {column} AS value
                FROM {table}
                WHERE {inner_where}
                ORDER BY ch_update_time DESC
                LIMIT 1 BY {dedup_keys}
            )
            WHERE value IS NOT NULL AND value != ''
            GROUP BY value
            ORDER BY n DESC
            LIMIT {DISCOVERY_LIMIT}
        """
        result = self._client.query(query, parameters=params, settings=READ_QUERY_SETTINGS)
        rows = [{"value": str(row[0]), "count": int(row[1])} for row in result.result_rows]
        self._cache_put(cache_key, rows)
        return rows


_service: TraceDiscoveryService | None = None


def get_trace_discovery_service() -> TraceDiscoveryService:
    """Get or create the singleton TraceDiscoveryService."""
    global _service
    if _service is None:
        _service = TraceDiscoveryService()
    return _service
