"""Service for reading traces from ClickHouse."""

from db.clickhouse import get_clickhouse_client


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
    ) -> dict:
        """List traces with aggregated metrics from spans."""
        offset = page * limit

        # Build WHERE conditions
        conditions = ["t.project_id = {project_id:String}"]
        params = {"project_id": project_id, "limit": limit, "offset": offset}

        if name:
            conditions.append("t.name ILIKE {name:String}")
            params["name"] = f"%{name}%"

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
                if(countIf(s.status = 'ERROR') > 0, 'error', 'ok') as status
            FROM traces FINAL t
            LEFT JOIN spans FINAL s ON t.trace_id = s.trace_id AND t.project_id = s.project_id
            WHERE {where_clause}
            GROUP BY t.trace_id, t.project_id, t.name, t.trace_start_time, t.user_id, t.session_id
            ORDER BY t.trace_start_time DESC
            LIMIT {{limit:UInt32}} OFFSET {{offset:UInt32}}
        """

        result = self._client.query(query, parameters=params)
        rows = result.result_rows

        # Get total count
        count_query = f"""
            SELECT count(DISTINCT t.trace_id)
            FROM traces FINAL t
            WHERE {where_clause}
        """
        count_result = self._client.query(count_query, parameters=params)
        total = count_result.result_rows[0][0] if count_result.result_rows else 0

        # Convert rows to dicts
        data = []
        for row in rows:
            data.append({
                "trace_id": row[0],
                "project_id": row[1],
                "name": row[2],
                "trace_start_time": row[3],
                "user_id": row[4],
                "session_id": row[5],
                "span_count": row[6] or 0,
                "duration_ms": float(row[7]) if row[7] is not None else None,
                "status": row[8],
            })

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
                user_id, session_id, environment, release, input, output
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
            "environment": row[6],
            "release": row[7],
            "input": row[8],
            "output": row[9],
        }

        # Fetch spans
        spans_query = """
            SELECT
                span_id, trace_id, parent_span_id, name, span_kind,
                span_start_time, span_end_time, status, status_message,
                model_name, cost, input, output
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
            spans.append({
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
                "input": row[11],
                "output": row[12],
            })

        trace["spans"] = spans
        return trace


# Singleton instance
_service: TraceReaderService | None = None


def get_trace_reader_service() -> TraceReaderService:
    """Get or create the singleton TraceReaderService."""
    global _service
    if _service is None:
        _service = TraceReaderService()
    return _service
