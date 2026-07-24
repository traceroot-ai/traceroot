"""Service for reading traces from ClickHouse."""

import time
from datetime import UTC, datetime, timedelta

from db.clickhouse import get_clickhouse_client
from rest.services.filters.translate import Predicate, build_conditions
from rest.sql_utils import escape_ilike, to_utc_naive
from worker.tokens.buckets import TokenBuckets, reconcile_cache_write_1h
from worker.tokens.pricing import cost_breakdown_from_buckets, get_model_price

# Lookback for the trace-detail spans query lower bound:
# span_start_time >= trace_start_time - this value.
# This gives room for clock skew and small differences between the stored
# trace_start_time and the true earliest span start time. Increase it if spans
# can validly start before the stored trace_start_time. Since spans are split by
# month with toYYYYMM(span_start_time), values under about a month usually skip
# the same old monthly partitions.
TRACE_SPAN_LOOKBACK_HOURS = 1

# Distinct-values endpoint: cap the option list and cache briefly. The dropdown only
# needs the frequent values, and the GROUP BY over spans is the heavy part — a short
# TTL absorbs repeated opens of the same filter without staleness mattering.
DISTINCT_VALUES_LIMIT = 100
DISTINCT_VALUES_CACHE_TTL_SECONDS = 30
# Bound the in-process cache so it can't grow without limit across projects/windows.
DISTINCT_VALUES_CACHE_MAX = 256

# Default lookback for a span scan that arrives with no lower time bound (the filtered
# trace list AND the categorical distinct-values dropdown). Those scan spans, so an
# unbounded window is a full-project span scan — the OOM-prone class. The dashboard
# always sends at least its default window, so this only bounds direct API callers and
# open-ended custom ranges. Matches the UI's own default preset ("Last 24 hours").
DEFAULT_SPAN_SCAN_LOOKBACK_HOURS = 24


def _floor_minute(dt: datetime | None) -> datetime | None:
    """Truncate a datetime to the whole minute (for the distinct-values cache key)."""
    return dt.replace(second=0, microsecond=0) if dt is not None else None


def _default_lookback_start(normalized_end: datetime | None) -> datetime:
    """Default lower bound for an otherwise-unbounded span scan.

    A fixed lookback before the window's end (``normalized_end``) — or before now when
    the window is open-ended — so the filtered list and the distinct-values query share
    one symmetric default and neither ever scans spans all-time.

    Args:
        normalized_end (datetime | None): Naive-UTC upper bound of the active window,
            or ``None`` for an open-ended window.

    Returns:
        datetime: Naive-UTC lower bound, ``lookback`` hours before the upper bound/now.
    """
    upper = normalized_end if normalized_end is not None else datetime.now(UTC).replace(tzinfo=None)
    return upper - timedelta(hours=DEFAULT_SPAN_SCAN_LOOKBACK_HOURS)


def span_cost_details(
    model_name: str | None,
    input_tokens: int | None,
    output_tokens: int | None,
    usage_details: dict[str, int],
) -> dict[str, float]:
    """Per-category dollar breakdown for a stored span.

    Rebuilds the disjoint token buckets from the stored GROSS input_tokens and the
    cache counts in usage_details, then prices each bucket with the model's current
    rates. Display-only: the values sum to the span's stored `cost` when rates are
    unchanged. Returns {} when the model has no known prices.
    """
    if not model_name:
        return {}
    cache_read = int(usage_details.get("cache_read_tokens", 0) or 0)
    cache_write = int(usage_details.get("cache_write_tokens", 0) or 0)
    # Optional 1-hour cache-write portion (absent for spans with no 1-hour writes and
    # for any emitter that doesn't report it). Reconciled against the write total with
    # the same rule used at ingest, so a stored breakdown can't over-count.
    cache_write_1h = reconcile_cache_write_1h(
        cache_write,
        int(usage_details.get("cache_write_1h_tokens", 0) or 0),
    )
    buckets = TokenBuckets(
        input_uncached=max((input_tokens or 0) - cache_read - cache_write, 0),
        output=output_tokens or 0,
        cache_read=cache_read,
        cache_write=cache_write,
        cache_write_1h=cache_write_1h,
    )
    return cost_breakdown_from_buckets(get_model_price(model_name), buckets) or {}


class TraceReaderService:
    """Read traces and spans from ClickHouse."""

    def __init__(self):
        self._client = get_clickhouse_client()
        # Per-(project, column, window) cache of distinct values: key -> (expiry, rows).
        self._distinct_cache: dict[tuple, tuple[float, list[dict]]] = {}

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
                monthly partitions. ``None`` scans all time.
            end_before (datetime | None): Upper bound on ``span_start_time`` (exclusive),
                symmetric with the trace list's window so the dropdown never offers
                values from traces newer than the active window's end.

        Returns:
            list[dict]: ``[{"value": str, "count": int}]`` ordered by descending
            frequency, capped at ``DISTINCT_VALUES_LIMIT``.
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
            frequency, capped at ``DISTINCT_VALUES_LIMIT``.
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
        normalized_start = to_utc_naive(start_after) if start_after is not None else None
        normalized_end = to_utc_naive(end_before) if end_before is not None else None
        # Never scan unbounded (the OOM class the filtered list guards against): if no
        # lower bound was given, default one — symmetric with the filtered trace list. The UI
        # always sends a window; this bounds a direct API caller that omits one.
        if normalized_start is None:
            normalized_start = _default_lookback_start(normalized_end)
        # Quantize the cache key to whole minutes so per-render jitter in the window
        # bounds (the UI recomputes "now - duration" every render) can't trivially
        # bypass the cache and force a fresh full-project GROUP BY on every open. The
        # 30s TTL already accepts this much staleness in the returned option list.
        cache_key = (
            table,
            project_id,
            column,
            _floor_minute(normalized_start),
            _floor_minute(normalized_end),
        )
        now = time.time()
        cached = self._distinct_cache.get(cache_key)
        if cached is not None and cached[0] > now:
            return cached[1]

        params: dict = {"project_id": project_id}
        inner_conditions = ["project_id = {project_id:String}"]
        if normalized_start is not None:
            # Exact bound, no lookback back-off: this is a self-contained window scan with
            # no trace-level semi-join, so the boundary-drift false-negative reasoning that
            # SPAN_TIME_BOUND_LOOKBACK_HOURS guards against in the filtered list doesn't apply.
            inner_conditions.append(f"{time_column} >= {{start_after:DateTime64(3)}}")
            params["start_after"] = normalized_start
        if normalized_end is not None:
            inner_conditions.append(f"{time_column} < {{end_before:DateTime64(3)}}")
            params["end_before"] = normalized_end
        inner_where = " AND ".join(inner_conditions)

        # Dedup ReplacingMergeTree rows to the latest version per logical row BEFORE
        # counting, so a since-updated row can't inflate a value's count or surface a stale
        # value. The column non-empty filter runs on the deduped (latest) value in the
        # outer query.
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
            LIMIT {DISTINCT_VALUES_LIMIT}
        """
        result = self._client.query(query, parameters=params)
        rows = [{"value": str(row[0]), "count": int(row[1])} for row in result.result_rows]
        # Bound the cache: drop expired entries, then evict oldest if still at capacity.
        self._distinct_cache = {k: v for k, v in self._distinct_cache.items() if v[0] > now}
        if len(self._distinct_cache) >= DISTINCT_VALUES_CACHE_MAX:
            self._distinct_cache.pop(next(iter(self._distinct_cache)))
        self._distinct_cache[cache_key] = (now + DISTINCT_VALUES_CACHE_TTL_SECONDS, rows)
        return rows

    def list_traces(
        self,
        project_id: str,
        page: int = 0,
        limit: int = 50,
        name: str | None = None,
        user_id: str | None = None,
        start_after: datetime | None = None,
        end_before: datetime | None = None,
        search_query: str | None = None,
        filters: list[Predicate] | None = None,
    ) -> dict:
        """List traces with aggregated metrics from spans."""
        offset = page * limit

        # Build WHERE conditions
        conditions = ["t.project_id = {project_id:String}"]
        params = {"project_id": project_id, "limit": limit, "offset": offset}

        if name:
            conditions.append("t.name ILIKE {name:String}")
            params["name"] = f"%{escape_ilike(name)}%"

        if user_id:
            conditions.append("t.user_id = {user_id:String}")
            params["user_id"] = user_id

        # Date range filtering (convert to UTC naive datetime for ClickHouse)
        if start_after is not None:
            conditions.append("t.trace_start_time >= {start_after:DateTime64(3)}")
            params["start_after"] = to_utc_naive(start_after)

        normalized_end = to_utc_naive(end_before) if end_before is not None else None
        if normalized_end is not None:
            conditions.append("t.trace_start_time < {end_before:DateTime64(3)}")
            params["end_before"] = normalized_end

        # Multi-field keyword search (trace_id, name, session_id, user_id)
        if search_query:
            conditions.append(
                "(t.trace_id ILIKE {search_kw:String} "
                "OR t.name ILIKE {search_kw:String} "
                "OR t.session_id ILIKE {search_kw:String} "
                "OR t.user_id ILIKE {search_kw:String})"
            )
            params["search_kw"] = f"%{escape_ilike(search_query)}%"

        # Filters scan spans (semi-joins), so a filtered list with no lower time bound
        # would be an unbounded full-project span scan in both the page and count queries.
        # Default a lookback window so those sub-queries prune monthly partitions, and bound
        # the trace query to the same window so the page, count, and span scans stay consistent.
        if filters and start_after is None:
            params["start_after"] = _default_lookback_start(normalized_end)
            conditions.append("t.trace_start_time >= {start_after:DateTime64(3)}")

        # Registry-driven attribute filters (model/cost/errors/...). Appended to the
        # SHARED conditions so they land in both the page query and the count query;
        # the span sub-queries reuse start_after (above) as a span-scan lower bound.
        conditions.extend(build_conditions(filters or [], params))

        where_clause = " AND ".join(conditions)

        # Page the traces FIRST (cheap: trace metadata only, deduped via LIMIT 1 BY
        # instead of FINAL), then aggregate spans for ONLY that page's trace_ids.
        # This avoids scanning/joining every span in the project on each list call,
        # and never groups by the large input/output text columns. See #963.
        query = f"""
            WITH page AS (
                -- Dedup ReplacingMergeTree by latest ch_update_time FIRST (correctness),
                -- THEN order by start time for pagination.
                SELECT
                    trace_id, project_id, name, trace_start_time,
                    user_id, session_id, input, output
                FROM (
                    SELECT
                        t.trace_id, t.project_id, t.name, t.trace_start_time,
                        t.user_id, t.session_id, t.input, t.output
                    FROM traces AS t
                    WHERE {where_clause}
                    ORDER BY t.ch_update_time DESC
                    LIMIT 1 BY t.project_id, t.trace_id
                )
                ORDER BY trace_start_time DESC
                LIMIT {{limit:UInt32}} OFFSET {{offset:UInt32}}
            ),
            span_agg AS (
                SELECT
                    trace_id,
                    count(span_id) as span_count,
                    if(
                        min(span_start_time) IS NOT NULL AND max(span_end_time) IS NOT NULL,
                        dateDiff('millisecond', min(span_start_time), max(span_end_time)),
                        NULL
                    ) as duration_ms,
                    countIf(status = 'ERROR') as error_count,
                    sum(input_tokens) as total_input_tokens,
                    sum(output_tokens) as total_output_tokens,
                    sum(cost) as total_cost
                FROM (
                    SELECT trace_id, span_id, status, span_start_time, span_end_time,
                           input_tokens, output_tokens, cost
                    FROM spans
                    WHERE project_id = {{project_id:String}}
                      AND trace_id IN (SELECT trace_id FROM page)
                    ORDER BY ch_update_time DESC
                    LIMIT 1 BY project_id, trace_id, span_id
                )
                GROUP BY trace_id
            )
            SELECT
                p.trace_id,
                p.project_id,
                p.name,
                p.trace_start_time,
                p.user_id,
                p.session_id,
                sa.span_count,
                sa.duration_ms,
                sa.error_count,
                p.input,
                p.output,
                sa.total_input_tokens,
                sa.total_output_tokens,
                sa.total_cost
            FROM page AS p
            LEFT JOIN span_agg AS sa ON p.trace_id = sa.trace_id
            ORDER BY p.trace_start_time DESC
        """

        result = self._client.query(query, parameters=params)
        rows = result.result_rows

        # Get total count (count(DISTINCT) dedupes ReplacingMergeTree rows; no FINAL)
        count_query = f"""
            SELECT count(DISTINCT t.trace_id)
            FROM traces AS t
            WHERE {where_clause}
        """
        count_result = self._client.query(count_query, parameters=params)
        total = count_result.result_rows[0][0] if count_result.result_rows else 0

        # Convert rows to dicts
        data = []
        for row in rows:
            data.append(
                {
                    "trace_id": row[0],
                    "project_id": row[1],
                    "name": row[2],
                    "trace_start_time": row[3],
                    "user_id": row[4],
                    "session_id": row[5],
                    "span_count": row[6] or 0,
                    "duration_ms": float(row[7]) if row[7] is not None else None,
                    "error_count": int(row[8]) if row[8] is not None else 0,
                    "input": row[9],
                    "output": row[10],
                    "total_input_tokens": int(row[11]) if row[11] is not None else 0,
                    "total_output_tokens": int(row[12]) if row[12] is not None else 0,
                    "total_cost": float(row[13]) if row[13] is not None else 0.0,
                }
            )

        return {
            "data": data,
            "meta": {"page": page, "limit": limit, "total": total},
        }

    def get_trace(self, project_id: str, trace_id: str) -> dict | None:
        """Get single trace with span skeletons (no per-span I/O).

        Returns trace metadata plus lightweight span skeletons that omit the
        large free-text input/output/metadata blobs. This keeps the payload
        sub-MB even for large traces. Per-span I/O is fetched on demand via
        get_span_io(). Columnar storage means dropping those columns from the
        SELECT avoids reading them entirely — no schema change needed.

        Trace-level input/output/metadata (on the trace row) are kept: they're
        small and already present.
        """
        # Fetch trace
        # Dedup the ReplacingMergeTree row without FINAL: keep the latest version
        # of this trace_id.
        trace_query = """
            SELECT
                trace_id, project_id, name, trace_start_time,
                user_id, session_id, git_ref, git_repo, input, output, metadata
            FROM traces
            WHERE project_id = {project_id:String} AND trace_id = {trace_id:String}
            ORDER BY ch_update_time DESC
            LIMIT 1 BY trace_id
        """
        trace_result = self._client.query(
            trace_query,
            parameters={"project_id": project_id, "trace_id": trace_id},
        )

        if not trace_result.result_rows:
            return None

        row = trace_result.result_rows[0]
        trace = {
            "trace_id": row[0],
            "project_id": row[1],
            "name": row[2],
            "trace_start_time": row[3],
            "user_id": row[4],
            "session_id": row[5],
            "git_ref": row[6],
            "git_repo": row[7],
            "input": row[8],
            "output": row[9],
            "metadata": row[10],
        }

        # Build the span skeleton query. The optional trace_start_time lower
        # bound lets ClickHouse prune old span partitions before the trace.
        spans_conditions = [
            "project_id = {project_id:String}",
            "trace_id = {trace_id:String}",
        ]
        spans_params = {"project_id": project_id, "trace_id": trace_id}
        if trace["trace_start_time"] is not None:
            # Lower-bound the spans scan by the trace start time so ClickHouse
            # can skip old monthly span partitions. The spans table uses
            # PARTITION BY toYYYYMM(span_start_time), and trace_id is not in the
            # sort key, so without a time bound every trace open can scan all
            # monthly partitions for the project. Keep this lower-bound only,
            # with no upper bound, so late or streaming child spans are still
            # returned. The lookback covers clock skew and trace start drift. If
            # trace_start_time is null, skip the bound because correctness
            # should not depend on it.
            spans_conditions.append(
                "span_start_time >= {trace_start_time:DateTime64(3)} "
                f"- INTERVAL {TRACE_SPAN_LOOKBACK_HOURS} HOUR"
            )
            spans_params["trace_start_time"] = to_utc_naive(trace["trace_start_time"])

        spans_where_clause = " AND ".join(spans_conditions)

        # Fetch span skeletons — omit the large input/output/metadata blobs to
        # keep the payload lightweight (fetched per-span on demand instead).
        # usage_details is kept (small map) to derive cost_details. Duration is
        # derived on the client from start/end so in-progress spans can grow
        # against `now()` for live traces.
        spans_query = f"""
            SELECT
                span_id, trace_id, parent_span_id, name, span_kind,
                span_start_time, span_end_time, status, status_message,
                model_name, cost, input_tokens, output_tokens, total_tokens,
                usage_details,
                git_source_file, git_source_line, git_source_function
            FROM (
                SELECT
                    span_id, trace_id, parent_span_id, name, span_kind,
                    span_start_time, span_end_time, status, status_message,
                    model_name, cost, input_tokens, output_tokens, total_tokens,
                    usage_details,
                    git_source_file, git_source_line, git_source_function
                FROM spans
                WHERE {spans_where_clause}
                ORDER BY ch_update_time DESC
                LIMIT 1 BY span_id
            )
            ORDER BY span_start_time ASC
        """
        spans_result = self._client.query(
            spans_query,
            parameters=spans_params,
        )

        spans = []
        for row in spans_result.result_rows:
            spans.append(
                {
                    "span_id": row[0],
                    "trace_id": row[1],
                    "parent_span_id": row[2],
                    "name": row[3],
                    "span_kind": row[4],
                    "span_start_time": row[5],
                    "span_end_time": row[6],
                    "status": row[7],
                    "status_message": row[8],
                    "model_name": row[9],
                    "cost": float(row[10]) if row[10] is not None else None,
                    "input_tokens": int(row[11]) if row[11] is not None else None,
                    "output_tokens": int(row[12]) if row[12] is not None else None,
                    "total_tokens": int(row[13]) if row[13] is not None else None,
                    "usage_details": dict(row[14]) if row[14] else {},
                    "cost_details": span_cost_details(
                        row[9],  # model_name
                        int(row[11]) if row[11] is not None else None,  # input_tokens
                        int(row[12]) if row[12] is not None else None,  # output_tokens
                        dict(row[14]) if row[14] else {},  # usage_details
                    ),
                    "git_source_file": row[15],
                    "git_source_line": int(row[16]) if row[16] is not None else None,
                    "git_source_function": row[17],
                }
            )

        trace["spans"] = spans
        return trace

    # Blob columns the bulk I/O reader may project, in a fixed order so the
    # generated SELECT is deterministic. Whitelist guards the f-string below.
    _IO_COLUMNS = ("input", "output", "metadata")

    def get_trace_spans_io(
        self, project_id: str, trace_id: str, columns: frozenset[str]
    ) -> dict[str, dict]:
        """Bulk-fetch the requested I/O columns for ALL spans in a trace, one query.

        The trace-wide complement to ``get_span_io``: export and agent reads need
        full per-span I/O without an N+1 fan-out of single-span calls. ``columns``
        is the projection's blob columns (from ``rest.projection.io_columns`` —
        any of ``input``/``output``/``metadata``); only those are SELECTed, so a
        narrow projection (e.g. ``metadata`` alone) never reads the other heavy
        blobs. Returns a ``{span_id: {column: value}}`` map. Callers merge it onto
        the skeleton spans from ``get_trace``; spans absent from the map keep
        whatever the skeleton carried, so a partial result never breaks
        serialization.

        Only invoked for ``io``/``metadata`` projections — the default skeleton
        read never reaches here, so this adds no cost to the dashboard path.
        """
        # Preserve a fixed column order and reject anything outside the whitelist
        # (the value is interpolated into the SQL, so never trust the caller).
        selected = [c for c in self._IO_COLUMNS if c in columns]
        if not selected:
            return {}

        select_clause = ", ".join(["span_id", *selected])
        query = f"""
            SELECT {select_clause}
            FROM (
                SELECT {select_clause}
                FROM spans
                WHERE project_id = {{project_id:String}} AND trace_id = {{trace_id:String}}
                ORDER BY ch_update_time DESC
                LIMIT 1 BY span_id
            )
        """
        result = self._client.query(
            query,
            parameters={"project_id": project_id, "trace_id": trace_id},
        )
        return {
            row[0]: {col: row[i + 1] for i, col in enumerate(selected)}
            for row in result.result_rows
        }

    def get_span_io(self, project_id: str, trace_id: str, span_id: str) -> dict | None:
        """Fetch full input/output/metadata for a single span on demand.

        Called when the user selects a span in the UI. Returns None when the
        span does not exist (router translates that to a 404).
        """
        query = """
            SELECT span_id, trace_id, input, output, metadata
            FROM spans
            WHERE project_id = {project_id:String}
              AND trace_id = {trace_id:String}
              AND span_id = {span_id:String}
            ORDER BY ch_update_time DESC
            LIMIT 1
        """
        result = self._client.query(
            query,
            parameters={
                "project_id": project_id,
                "trace_id": trace_id,
                "span_id": span_id,
            },
        )
        if not result.result_rows:
            return None
        row = result.result_rows[0]
        return {
            "span_id": row[0],
            "trace_id": row[1],
            "input": row[2],
            "output": row[3],
            "metadata": row[4],
        }

    def list_sessions(
        self,
        project_id: str,
        page: int = 0,
        limit: int = 50,
        search_query: str | None = None,
        start_after: datetime | None = None,
        end_before: datetime | None = None,
    ) -> dict:
        """List unique sessions with aggregated trace statistics."""
        offset = page * limit

        # Build WHERE conditions on the traces table
        conditions = [
            "t.project_id = {project_id:String}",
            "t.session_id IS NOT NULL",
            "t.session_id != ''",
        ]
        params: dict = {"project_id": project_id, "limit": limit, "offset": offset}

        if search_query:
            conditions.append("t.session_id ILIKE {search_kw:String}")
            params["search_kw"] = f"%{escape_ilike(search_query)}%"

        if start_after is not None:
            conditions.append("t.trace_start_time >= {start_after:DateTime64(3)}")
            params["start_after"] = to_utc_naive(start_after)

        if end_before is not None:
            conditions.append("t.trace_start_time < {end_before:DateTime64(3)}")
            params["end_before"] = to_utc_naive(end_before)

        where_clause = " AND ".join(conditions)

        # Page the sessions FIRST (cheap: trace metadata only, deduped via LIMIT 1 BY
        # instead of FINAL), then dedupe the traces for that page of sessions and
        # aggregate spans for only those trace_ids. Avoids the full traces x spans
        # FINAL join + group-by-on-text over the whole project on each call. See #963.
        query = f"""
            WITH session_page AS (
                SELECT t.session_id
                FROM (
                    SELECT t.session_id, t.trace_start_time
                    FROM traces AS t
                    WHERE {where_clause}
                    ORDER BY t.ch_update_time DESC
                    LIMIT 1 BY t.project_id, t.trace_id
                ) AS t
                GROUP BY t.session_id
                ORDER BY max(t.trace_start_time) DESC
                LIMIT {{limit:UInt32}} OFFSET {{offset:UInt32}}
            ),
            traces_dedup AS (
                SELECT
                    t.session_id, t.trace_id, t.trace_start_time, t.user_id,
                    t.input as trace_input, t.output as trace_output
                FROM traces AS t
                WHERE {where_clause}
                  AND t.session_id IN (SELECT session_id FROM session_page)
                ORDER BY t.ch_update_time DESC
                LIMIT 1 BY t.project_id, t.trace_id
            ),
            span_agg AS (
                SELECT
                    trace_id,
                    if(
                        min(span_start_time) IS NOT NULL AND max(span_end_time) IS NOT NULL,
                        dateDiff('millisecond', min(span_start_time), max(span_end_time)),
                        NULL
                    ) as trace_duration_ms,
                    sum(input_tokens) as trace_input_tokens,
                    sum(output_tokens) as trace_output_tokens,
                    sum(cost) as trace_cost
                FROM (
                    SELECT trace_id, span_id, span_start_time, span_end_time,
                           input_tokens, output_tokens, cost
                    FROM spans
                    WHERE project_id = {{project_id:String}}
                      AND trace_id IN (SELECT trace_id FROM traces_dedup)
                    ORDER BY ch_update_time DESC
                    LIMIT 1 BY project_id, trace_id, span_id
                )
                GROUP BY trace_id
            )
            SELECT
                td.session_id,
                count(*) as trace_count,
                groupUniqArray(td.user_id) as user_ids,
                min(td.trace_start_time) as first_trace_time,
                max(td.trace_start_time) as last_trace_time,
                sum(sa.trace_duration_ms) as duration_ms,
                sum(sa.trace_input_tokens) as total_input_tokens,
                sum(sa.trace_output_tokens) as total_output_tokens,
                sum(sa.trace_cost) as total_cost,
                argMin(td.trace_input, td.trace_start_time) as trace_input,
                argMax(td.trace_output, td.trace_start_time) as trace_output
            FROM traces_dedup AS td
            LEFT JOIN span_agg AS sa ON td.trace_id = sa.trace_id
            GROUP BY td.session_id
            ORDER BY last_trace_time DESC
        """

        result = self._client.query(query, parameters=params)

        # Total distinct sessions. Dedup traces to their latest version first (via
        # LIMIT 1 BY) so a session_id changed across versions isn't double-counted.
        count_query = f"""
            SELECT count(DISTINCT session_id)
            FROM (
                SELECT t.session_id
                FROM traces AS t
                WHERE {where_clause}
                ORDER BY t.ch_update_time DESC
                LIMIT 1 BY t.project_id, t.trace_id
            )
        """
        count_result = self._client.query(count_query, parameters=params)
        total = count_result.result_rows[0][0] if count_result.result_rows else 0

        data = []
        session_ids_needing_span_io: list[str] = []
        for row in result.result_rows:
            # Filter out empty strings from user_ids
            user_ids = [uid for uid in row[2] if uid]
            trace_input = row[9] or None
            trace_output = row[10] or None
            entry = {
                "session_id": row[0],
                "trace_count": row[1],
                "user_ids": user_ids,
                "first_trace_time": row[3],
                "last_trace_time": row[4],
                "duration_ms": float(row[5]) if row[5] is not None else None,
                "total_input_tokens": int(row[6]) if row[6] is not None else None,
                "total_output_tokens": int(row[7]) if row[7] is not None else None,
                "total_cost": float(row[8]) if row[8] is not None else None,
                "input": trace_input,
                "output": trace_output,
            }
            data.append(entry)
            if self._is_empty_io(trace_input) or self._is_empty_io(trace_output):
                session_ids_needing_span_io.append(row[0])

        # Backfill input/output from spans for sessions with empty trace-level I/O
        if session_ids_needing_span_io:
            # Dedup both sides without FINAL: resolve the sessions' traces first
            # (latest per trace), then dedup only the spans in those traces
            # (scoped via the trace_id IN subquery so we never dedup the whole
            # project), then join + aggregate.
            span_io_query = """
                WITH session_traces AS (
                    SELECT t.session_id, t.trace_id, t.project_id
                    FROM traces AS t
                    WHERE t.project_id = {project_id:String}
                      AND t.session_id IN ({session_ids:Array(String)})
                    ORDER BY t.ch_update_time DESC
                    LIMIT 1 BY t.project_id, t.trace_id
                ),
                spans_dedup AS (
                    SELECT trace_id, project_id, input, output, span_start_time, span_end_time
                    FROM spans
                    WHERE project_id = {project_id:String}
                      AND trace_id IN (SELECT trace_id FROM session_traces)
                    ORDER BY ch_update_time DESC
                    LIMIT 1 BY span_id
                )
                SELECT
                    st.session_id,
                    argMin(s.input, s.span_start_time) as first_input,
                    argMax(s.output, s.span_end_time) as last_output
                FROM session_traces AS st
                JOIN spans_dedup AS s
                    ON st.trace_id = s.trace_id AND st.project_id = s.project_id
                WHERE ((s.input != '' AND s.input != '{}') OR (s.output != '' AND s.output != '{}'))
                GROUP BY st.session_id
            """
            span_io_result = self._client.query(
                span_io_query,
                parameters={**params, "session_ids": session_ids_needing_span_io},
            )
            span_io_map: dict[str, tuple[str | None, str | None]] = {}
            for row in span_io_result.result_rows:
                span_io_map[row[0]] = (row[1], row[2])

            for entry in data:
                span_io = span_io_map.get(entry["session_id"])
                if span_io:
                    if self._is_empty_io(entry["input"]) and not self._is_empty_io(span_io[0]):
                        entry["input"] = span_io[0]
                    if self._is_empty_io(entry["output"]) and not self._is_empty_io(span_io[1]):
                        entry["output"] = span_io[1]

        return {
            "data": data,
            "meta": {"page": page, "limit": limit, "total": total},
        }

    @staticmethod
    def _is_empty_io(value: str | None) -> bool:
        """Check if an input/output value is empty or just '{}'."""
        if not value:
            return True
        stripped = value.strip()
        return stripped in ("", "{}", "null", "None")

    def get_session(
        self,
        project_id: str,
        session_id: str,
        start_after: datetime | None = None,
        end_before: datetime | None = None,
    ) -> dict | None:
        """Get session detail with all traces for conversation view."""
        params: dict = {"project_id": project_id, "session_id": session_id}

        # Build WHERE conditions
        conditions = [
            "t.project_id = {project_id:String}",
            "t.session_id = {session_id:String}",
        ]

        # Date range filtering
        if start_after is not None:
            conditions.append("t.trace_start_time >= {start_after:DateTime64(3)}")
            params["start_after"] = to_utc_naive(start_after)

        if end_before is not None:
            conditions.append("t.trace_start_time < {end_before:DateTime64(3)}")
            params["end_before"] = to_utc_naive(end_before)

        where_clause = " AND ".join(conditions)

        # Step 1: Get all traces for this session with basic info.
        # Dedup both sides without FINAL: dedup this session's traces first, then
        # dedup only the spans in those traces (scoped via trace_id IN, so the
        # whole project is never deduped), then LEFT JOIN + aggregate.
        traces_query = f"""
            WITH traces_dedup AS (
                SELECT
                    t.trace_id, t.project_id, t.name, t.trace_start_time,
                    t.user_id, t.input, t.output
                FROM traces AS t
                WHERE {where_clause}
                ORDER BY t.ch_update_time DESC
                LIMIT 1 BY t.project_id, t.trace_id
            ),
            spans_dedup AS (
                SELECT trace_id, project_id, span_start_time, span_end_time, status
                FROM spans
                WHERE project_id = {{project_id:String}}
                  AND trace_id IN (SELECT trace_id FROM traces_dedup)
                ORDER BY ch_update_time DESC
                LIMIT 1 BY span_id
            )
            SELECT
                t.trace_id,
                t.name,
                t.trace_start_time,
                t.user_id,
                t.input,
                t.output,
                if(
                    min(s.span_start_time) IS NOT NULL AND max(s.span_end_time) IS NOT NULL,
                    dateDiff('millisecond', min(s.span_start_time), max(s.span_end_time)),
                    NULL
                ) as duration_ms,
                if(countIf(s.status = 'ERROR') > 0, 'error', 'ok') as status
            FROM traces_dedup AS t
            LEFT JOIN spans_dedup AS s ON t.trace_id = s.trace_id AND t.project_id = s.project_id
            GROUP BY t.trace_id, t.name, t.trace_start_time, t.user_id, t.input, t.output
            ORDER BY t.trace_start_time ASC
        """
        traces_result = self._client.query(traces_query, parameters=params)

        if not traces_result.result_rows:
            return None

        traces = []
        user_ids_set: set[str] = set()
        trace_ids = []
        for row in traces_result.result_rows:
            if row[3]:  # user_id
                user_ids_set.add(row[3])
            trace_ids.append(row[0])
            traces.append(
                {
                    "trace_id": row[0],
                    "name": row[1],
                    "trace_start_time": row[2],
                    "user_id": row[3],
                    "input": row[4],
                    "output": row[5],
                    "duration_ms": float(row[6]) if row[6] is not None else None,
                    "status": row[7],
                }
            )

        # Step 2: For traces with empty input/output, fetch from root spans
        # The SDK often stores real I/O on agent_turn or root spans, not traces
        needs_span_io = any(
            self._is_empty_io(t["input"]) or self._is_empty_io(t["output"]) for t in traces
        )
        if needs_span_io and trace_ids:
            # Get the first span's input and last span's output per trace
            # (root span = no parent, or earliest AGENT span with real data)
            # Dedup spans without FINAL (latest per span_id, scoped to these
            # traces), then aggregate I/O over the deduped rows.
            span_io_query = """
                SELECT
                    trace_id,
                    argMin(input, span_start_time) as first_input,
                    argMax(output, span_end_time) as last_output
                FROM (
                    SELECT trace_id, input, output, span_start_time, span_end_time
                    FROM spans
                    WHERE project_id = {project_id:String}
                      AND trace_id IN ({trace_ids:Array(String)})
                    ORDER BY ch_update_time DESC
                    LIMIT 1 BY span_id
                )
                WHERE ((input != '' AND input != '{}') OR (output != '' AND output != '{}'))
                GROUP BY trace_id
            """
            span_io_result = self._client.query(
                span_io_query,
                parameters={**params, "trace_ids": trace_ids},
            )
            span_io_map: dict[str, tuple[str | None, str | None]] = {}
            for row in span_io_result.result_rows:
                span_io_map[row[0]] = (row[1], row[2])

            # Patch traces with span-level I/O where trace-level is empty
            for t in traces:
                span_io = span_io_map.get(t["trace_id"])
                if span_io:
                    if self._is_empty_io(t["input"]) and not self._is_empty_io(span_io[0]):
                        t["input"] = span_io[0]
                    if self._is_empty_io(t["output"]) and not self._is_empty_io(span_io[1]):
                        t["output"] = span_io[1]

        # Step 3: Get token totals from spans for all traces in this session
        # Dedup spans without FINAL (latest per span_id), then sum tokens/cost.
        tokens_query = """
            SELECT
                sum(input_tokens) as total_input_tokens,
                sum(output_tokens) as total_output_tokens,
                sum(cost) as total_cost
            FROM (
                SELECT input_tokens, output_tokens, cost
                FROM spans
                WHERE project_id = {project_id:String}
                  AND trace_id IN ({trace_ids:Array(String)})
                ORDER BY ch_update_time DESC
                LIMIT 1 BY span_id
            )
        """
        tokens_result = self._client.query(
            tokens_query,
            parameters={**params, "trace_ids": trace_ids},
        )
        token_row = (
            tokens_result.result_rows[0] if tokens_result.result_rows else (None, None, None)
        )

        first_time = traces[0]["trace_start_time"] if traces else None
        last_time = traces[-1]["trace_start_time"] if traces else None
        # Sum of individual trace durations (not wall clock time between first and last)
        valid_durations = [t["duration_ms"] for t in traces if t["duration_ms"] is not None]
        duration_ms = sum(valid_durations) if valid_durations else None

        return {
            "session_id": session_id,
            "traces": traces,
            "user_ids": sorted(user_ids_set),
            "trace_count": len(traces),
            "first_trace_time": first_time,
            "last_trace_time": last_time,
            "duration_ms": duration_ms,
            "total_input_tokens": int(token_row[0]) if token_row[0] is not None else None,
            "total_output_tokens": int(token_row[1]) if token_row[1] is not None else None,
            "total_cost": float(token_row[2]) if token_row[2] is not None else None,
        }

    def list_users(
        self,
        project_id: str,
        page: int = 0,
        limit: int = 50,
        search_query: str | None = None,
        start_after: datetime | None = None,
        end_before: datetime | None = None,
    ) -> dict:
        """List unique users with trace counts."""
        offset = page * limit

        # Build WHERE conditions
        conditions = [
            "t.project_id = {project_id:String}",
            "t.user_id IS NOT NULL",
            "t.user_id != ''",
        ]
        params: dict = {"project_id": project_id, "limit": limit, "offset": offset}

        # Search by user_id
        if search_query:
            conditions.append("t.user_id ILIKE {search_kw:String}")
            params["search_kw"] = f"%{escape_ilike(search_query)}%"

        # Date range filtering
        if start_after:
            conditions.append("t.trace_start_time >= {start_after:DateTime64(3)}")
            params["start_after"] = to_utc_naive(start_after)

        if end_before:
            conditions.append("t.trace_start_time <= {end_before:DateTime64(3)}")
            params["end_before"] = to_utc_naive(end_before)

        where_clause = " AND ".join(conditions)

        # Page the users FIRST (trace_count / last_trace_time come from traces alone,
        # deduped via LIMIT 1 BY instead of FINAL), then sum span tokens/cost for only
        # that page's users' traces. Avoids the full traces x spans FINAL join over the
        # whole project on each call. See #963.
        query = f"""
            WITH user_page AS (
                SELECT
                    user_id,
                    count(DISTINCT trace_id) as trace_count,
                    max(trace_start_time) as last_trace_time
                FROM (
                    SELECT t.user_id, t.trace_id, t.trace_start_time
                    FROM traces AS t
                    WHERE {where_clause}
                    ORDER BY t.ch_update_time DESC
                    LIMIT 1 BY t.project_id, t.trace_id
                )
                GROUP BY user_id
                ORDER BY last_trace_time DESC
                LIMIT {{limit:UInt32}} OFFSET {{offset:UInt32}}
            ),
            user_traces AS (
                SELECT t.user_id, t.trace_id
                FROM traces AS t
                WHERE {where_clause}
                  AND t.user_id IN (SELECT user_id FROM user_page)
                ORDER BY t.ch_update_time DESC
                LIMIT 1 BY t.project_id, t.trace_id
            ),
            span_totals AS (
                SELECT
                    ut.user_id,
                    sum(s.input_tokens) as total_input_tokens,
                    sum(s.output_tokens) as total_output_tokens,
                    sum(s.cost) as total_cost
                FROM user_traces AS ut
                LEFT JOIN (
                    SELECT trace_id, span_id, input_tokens, output_tokens, cost
                    FROM spans
                    WHERE project_id = {{project_id:String}}
                      AND trace_id IN (SELECT trace_id FROM user_traces)
                    ORDER BY ch_update_time DESC
                    LIMIT 1 BY project_id, trace_id, span_id
                ) AS s ON ut.trace_id = s.trace_id
                GROUP BY ut.user_id
            )
            SELECT
                up.user_id,
                up.trace_count,
                up.last_trace_time,
                st.total_input_tokens,
                st.total_output_tokens,
                st.total_cost
            FROM user_page AS up
            LEFT JOIN span_totals AS st ON up.user_id = st.user_id
            ORDER BY up.last_trace_time DESC
        """

        result = self._client.query(query, parameters=params)

        # Total distinct users. Dedup traces to their latest version first (via
        # LIMIT 1 BY) so a user_id changed across versions isn't double-counted.
        count_query = f"""
            SELECT count(DISTINCT user_id)
            FROM (
                SELECT t.user_id
                FROM traces AS t
                WHERE {where_clause}
                ORDER BY t.ch_update_time DESC
                LIMIT 1 BY t.project_id, t.trace_id
            )
        """
        count_result = self._client.query(count_query, parameters=params)
        total = count_result.result_rows[0][0] if count_result.result_rows else 0

        data = []
        for row in result.result_rows:
            data.append(
                {
                    "user_id": row[0],
                    "trace_count": row[1],
                    "last_trace_time": row[2],
                    "total_input_tokens": int(row[3]) if row[3] is not None else None,
                    "total_output_tokens": int(row[4]) if row[4] is not None else None,
                    "total_cost": float(row[5]) if row[5] is not None else None,
                }
            )

        return {
            "data": data,
            "meta": {"page": page, "limit": limit, "total": total},
        }


# Singleton instance
_service: TraceReaderService | None = None


def get_trace_reader_service() -> TraceReaderService:
    """Get or create the singleton TraceReaderService."""
    global _service
    if _service is None:
        _service = TraceReaderService()
    return _service
