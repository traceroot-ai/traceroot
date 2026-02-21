"""Service for reading traces from ClickHouse."""

from datetime import UTC, datetime

from db.clickhouse import get_clickhouse_client


def _to_utc_naive(dt: datetime) -> datetime:
    """Convert datetime to UTC naive datetime for ClickHouse comparison."""
    if dt.tzinfo is not None:
        # Convert to UTC then remove timezone info
        return dt.astimezone(UTC).replace(tzinfo=None)
    return dt


class TraceReaderService:
    """Read traces and spans from ClickHouse."""

    def __init__(self):
        self._client = get_clickhouse_client()

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
    ) -> dict:
        """List traces with aggregated metrics from spans."""
        offset = page * limit

        # Build WHERE conditions
        conditions = ["t.project_id = {project_id:String}"]
        params = {"project_id": project_id, "limit": limit, "offset": offset}

        if name:
            conditions.append("t.name ILIKE {name:String}")
            params["name"] = f"%{name}%"

        if user_id:
            conditions.append("t.user_id = {user_id:String}")
            params["user_id"] = user_id

        # Date range filtering (convert to UTC naive datetime for ClickHouse)
        if start_after:
            conditions.append("t.trace_start_time >= {start_after:DateTime64(3)}")
            params["start_after"] = _to_utc_naive(start_after)

        if end_before:
            conditions.append("t.trace_start_time <= {end_before:DateTime64(3)}")
            params["end_before"] = _to_utc_naive(end_before)

        # Multi-field keyword search (trace_id, name, session_id, user_id)
        if search_query:
            conditions.append(
                "(t.trace_id ILIKE {search_kw:String} "
                "OR t.name ILIKE {search_kw:String} "
                "OR t.session_id ILIKE {search_kw:String} "
                "OR t.user_id ILIKE {search_kw:String})"
            )
            params["search_kw"] = f"%{search_query}%"

        where_clause = " AND ".join(conditions)

        # Query traces with span aggregates
        # Use FINAL to deduplicate ReplacingMergeTree rows
        query = f"""
            SELECT
                t.trace_id,
                t.project_id,
                t.name,
                t.trace_start_time,
                t.user_id,
                t.session_id,
                count(s.span_id) as span_count,
                if(
                    min(s.span_start_time) IS NOT NULL AND max(s.span_end_time) IS NOT NULL,
                    dateDiff('millisecond', min(s.span_start_time), max(s.span_end_time)),
                    NULL
                ) as duration_ms,
                if(countIf(s.status = 'ERROR') > 0, 'error', 'ok') as status,
                t.input,
                t.output
            FROM traces AS t FINAL
            LEFT JOIN spans AS s FINAL ON t.trace_id = s.trace_id AND t.project_id = s.project_id
            WHERE {where_clause}
            GROUP BY t.trace_id, t.project_id, t.name, t.trace_start_time, t.user_id, t.session_id, t.input, t.output
            ORDER BY t.trace_start_time DESC
            LIMIT {{limit:UInt32}} OFFSET {{offset:UInt32}}
        """

        result = self._client.query(query, parameters=params)
        rows = result.result_rows

        # Get total count
        count_query = f"""
            SELECT count(DISTINCT t.trace_id)
            FROM traces AS t FINAL
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
                    "status": row[8],
                    "input": row[9],
                    "output": row[10],
                }
            )

        return {
            "data": data,
            "meta": {"page": page, "limit": limit, "total": total},
        }

    def get_trace(self, project_id: str, trace_id: str) -> dict | None:
        """Get single trace with all spans."""
        # Fetch trace
        trace_query = """
            SELECT
                trace_id, project_id, name, trace_start_time,
                user_id, session_id, git_ref, git_repo, input, output, metadata
            FROM traces FINAL
            WHERE project_id = {project_id:String} AND trace_id = {trace_id:String}
            LIMIT 1
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

        # Fetch spans
        spans_query = """
            SELECT
                span_id, trace_id, parent_span_id, name, span_kind,
                span_start_time, span_end_time, status, status_message,
                model_name, cost, input_tokens, output_tokens, total_tokens,
                input, output, metadata,
                git_source_file, git_source_line, git_source_function
            FROM spans FINAL
            WHERE project_id = {project_id:String} AND trace_id = {trace_id:String}
            ORDER BY span_start_time ASC
        """
        spans_result = self._client.query(
            spans_query,
            parameters={"project_id": project_id, "trace_id": trace_id},
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
                    "input": row[14],
                    "output": row[15],
                    "metadata": row[16],
                    "git_source_file": row[17],
                    "git_source_line": int(row[18]) if row[18] is not None else None,
                    "git_source_function": row[19],
                }
            )

        trace["spans"] = spans
        return trace

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
            params["search_kw"] = f"%{search_query}%"

        if start_after:
            conditions.append("t.trace_start_time >= {start_after:DateTime64(3)}")
            params["start_after"] = _to_utc_naive(start_after)

        if end_before:
            conditions.append("t.trace_start_time <= {end_before:DateTime64(3)}")
            params["end_before"] = _to_utc_naive(end_before)

        where_clause = " AND ".join(conditions)

        query = f"""
            SELECT
                t.session_id,
                count(DISTINCT t.trace_id) as trace_count,
                groupUniqArray(t.user_id) as user_ids,
                min(t.trace_start_time) as first_trace_time,
                max(t.trace_start_time) as last_trace_time,
                dateDiff('millisecond', min(t.trace_start_time), max(t.trace_start_time)) as duration_ms,
                sum(s.input_tokens) as total_input_tokens,
                sum(s.output_tokens) as total_output_tokens,
                argMin(t.input, t.trace_start_time) as trace_input,
                argMax(t.output, t.trace_start_time) as trace_output
            FROM traces AS t FINAL
            LEFT JOIN spans AS s FINAL ON t.trace_id = s.trace_id AND t.project_id = s.project_id
            WHERE {where_clause}
            GROUP BY t.session_id
            ORDER BY last_trace_time DESC
            LIMIT {{limit:UInt32}} OFFSET {{offset:UInt32}}
        """

        result = self._client.query(query, parameters=params)

        # Get total count of distinct sessions
        count_query = f"""
            SELECT count(DISTINCT t.session_id)
            FROM traces AS t FINAL
            WHERE {where_clause}
        """
        count_result = self._client.query(count_query, parameters=params)
        total = count_result.result_rows[0][0] if count_result.result_rows else 0

        data = []
        session_ids_needing_span_io: list[str] = []
        for row in result.result_rows:
            # Filter out empty strings from user_ids
            user_ids = [uid for uid in row[2] if uid]
            trace_input = row[8] or None
            trace_output = row[9] or None
            entry = {
                "session_id": row[0],
                "trace_count": row[1],
                "user_ids": user_ids,
                "first_trace_time": row[3],
                "last_trace_time": row[4],
                "duration_ms": float(row[5]) if row[5] is not None else None,
                "total_input_tokens": int(row[6]) if row[6] is not None else None,
                "total_output_tokens": int(row[7]) if row[7] is not None else None,
                "input": trace_input,
                "output": trace_output,
            }
            data.append(entry)
            if self._is_empty_io(trace_input) or self._is_empty_io(trace_output):
                session_ids_needing_span_io.append(row[0])

        # Backfill input/output from spans for sessions with empty trace-level I/O
        if session_ids_needing_span_io:
            span_io_query = """
                SELECT
                    t.session_id,
                    argMin(s.input, s.span_start_time) as first_input,
                    argMax(s.output, s.span_end_time) as last_output
                FROM traces AS t FINAL
                JOIN spans AS s FINAL ON t.trace_id = s.trace_id AND t.project_id = s.project_id
                WHERE t.project_id = {project_id:String}
                  AND t.session_id IN ({session_ids:Array(String)})
                  AND ((s.input != '' AND s.input != '{}') OR (s.output != '' AND s.output != '{}'))
                GROUP BY t.session_id
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

    def get_session(self, project_id: str, session_id: str) -> dict | None:
        """Get session detail with all traces for conversation view."""
        params: dict = {"project_id": project_id, "session_id": session_id}

        # Step 1: Get all traces for this session with basic info
        traces_query = """
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
            FROM traces AS t FINAL
            LEFT JOIN spans AS s FINAL ON t.trace_id = s.trace_id AND t.project_id = s.project_id
            WHERE t.project_id = {project_id:String} AND t.session_id = {session_id:String}
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
            span_io_query = """
                SELECT
                    trace_id,
                    argMin(input, span_start_time) as first_input,
                    argMax(output, span_end_time) as last_output
                FROM spans FINAL
                WHERE project_id = {project_id:String}
                  AND trace_id IN ({trace_ids:Array(String)})
                  AND ((input != '' AND input != '{}') OR (output != '' AND output != '{}'))
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
        tokens_query = """
            SELECT
                sum(input_tokens) as total_input_tokens,
                sum(output_tokens) as total_output_tokens
            FROM spans FINAL
            WHERE project_id = {project_id:String}
              AND trace_id IN ({trace_ids:Array(String)})
        """
        tokens_result = self._client.query(
            tokens_query,
            parameters={**params, "trace_ids": trace_ids},
        )
        token_row = tokens_result.result_rows[0] if tokens_result.result_rows else (None, None)

        first_time = traces[0]["trace_start_time"] if traces else None
        last_time = traces[-1]["trace_start_time"] if traces else None
        duration_ms = None
        if first_time and last_time and first_time != last_time:
            duration_ms = (last_time - first_time).total_seconds() * 1000

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
            "project_id = {project_id:String}",
            "user_id IS NOT NULL",
            "user_id != ''",
        ]
        params: dict = {"project_id": project_id, "limit": limit, "offset": offset}

        # Search by user_id
        if search_query:
            conditions.append("user_id ILIKE {search_kw:String}")
            params["search_kw"] = f"%{search_query}%"

        # Date range filtering
        if start_after:
            conditions.append("trace_start_time >= {start_after:DateTime64(3)}")
            params["start_after"] = _to_utc_naive(start_after)

        if end_before:
            conditions.append("trace_start_time <= {end_before:DateTime64(3)}")
            params["end_before"] = _to_utc_naive(end_before)

        where_clause = " AND ".join(conditions)

        query = f"""
            SELECT
                user_id,
                count(DISTINCT trace_id) as trace_count,
                max(trace_start_time) as last_trace_time
            FROM traces FINAL
            WHERE {where_clause}
            GROUP BY user_id
            ORDER BY last_trace_time DESC
            LIMIT {{limit:UInt32}} OFFSET {{offset:UInt32}}
        """

        result = self._client.query(query, parameters=params)

        # Get total count
        count_query = f"""
            SELECT count(DISTINCT user_id)
            FROM traces FINAL
            WHERE {where_clause}
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
