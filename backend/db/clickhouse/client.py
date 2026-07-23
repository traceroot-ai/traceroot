"""ClickHouse client using clickhouse-connect."""

from datetime import UTC, datetime
from typing import Any

import clickhouse_connect
from clickhouse_connect.driver.client import Client
from clickhouse_connect.driver.query import QueryResult

from shared.config import settings


class ClickHouseClient:
    """ClickHouse client wrapper for trace data operations."""

    def __init__(self, client: Client):
        self._client = client

    @classmethod
    def from_settings(cls) -> "ClickHouseClient":
        """Create client from centralized settings."""
        ch = settings.clickhouse
        client = clickhouse_connect.get_client(
            host=ch.host,
            port=ch.port,
            username=ch.user,
            password=ch.password,
            database=ch.database,
            # Disable the sticky server-side session so this shared singleton client
            # can serve concurrent queries (the two-phase trace view fans out a
            # skeleton + many per-span /io requests at once). Otherwise clickhouse-
            # connect raises "concurrent queries within the same session". Our usage
            # is stateless reads/inserts/DDL — no temp tables or session SETs — so
            # this is a no-op semantically — just the standard sessionless, pooled
            # shared-client pattern used by mature ClickHouse-backed services.
            autogenerate_session_id=False,
        )
        return cls(client)

    def insert_traces_batch(self, traces: list[dict[str, Any]]) -> None:
        """Insert multiple trace records."""
        if not traces:
            return

        now = datetime.now(UTC)
        rows = []
        for t in traces:
            rows.append(
                [
                    t["trace_id"],
                    t["project_id"],
                    t["trace_start_time"],
                    t["name"],
                    t.get("user_id"),
                    t.get("session_id"),
                    t.get("git_ref"),
                    t.get("git_repo"),
                    t.get("input"),
                    t.get("output"),
                    t.get("metadata"),
                    now,  # ch_create_time
                    now,  # ch_update_time
                ]
            )

        self._client.insert(
            "traces",
            rows,
            column_names=[
                "trace_id",
                "project_id",
                "trace_start_time",
                "name",
                "user_id",
                "session_id",
                "git_ref",
                "git_repo",
                "input",
                "output",
                "metadata",
                "ch_create_time",
                "ch_update_time",
            ],
        )

    def insert_spans_batch(self, spans: list[dict[str, Any]]) -> None:
        """Insert multiple span records."""
        if not spans:
            return

        now = datetime.now(UTC)
        rows = []
        for s in spans:
            rows.append(
                [
                    s["span_id"],
                    s["trace_id"],
                    s.get("parent_span_id"),
                    s["project_id"],
                    s["span_start_time"],
                    s.get("span_end_time"),
                    s["name"],
                    s["span_kind"],
                    s.get("status", "OK"),
                    s.get("status_message"),
                    s.get("model_name"),
                    s.get("cost"),
                    s.get("input_tokens"),
                    s.get("output_tokens"),
                    s.get("total_tokens"),
                    s.get("usage_details") or {},
                    s.get("input"),
                    s.get("output"),
                    s.get("metadata"),
                    s.get("git_source_file"),
                    s.get("git_source_line"),
                    s.get("git_source_function"),
                    now,  # ch_create_time
                    now,  # ch_update_time
                ]
            )

        self._client.insert(
            "spans",
            rows,
            column_names=[
                "span_id",
                "trace_id",
                "parent_span_id",
                "project_id",
                "span_start_time",
                "span_end_time",
                "name",
                "span_kind",
                "status",
                "status_message",
                "model_name",
                "cost",
                "input_tokens",
                "output_tokens",
                "total_tokens",
                "usage_details",
                "input",
                "output",
                "metadata",
                "git_source_file",
                "git_source_line",
                "git_source_function",
                "ch_create_time",
                "ch_update_time",
            ],
        )

    def query(
        self,
        query: str,
        parameters: dict[str, Any] | None = None,
        settings: dict[str, Any] | None = None,
    ) -> QueryResult:
        """Execute a query and return the result.

        ``parameters`` and ``settings`` are different channels: parameters
        bind *data* into the SQL's placeholders, settings tell the ClickHouse
        server *how* it may execute this one query.

        Args:
            query (str): SQL text, optionally with ``{name:Type}`` server-side
                parameter bindings.
            parameters (dict[str, Any] | None): Values for the server-side
                bindings.
            settings (dict[str, Any] | None): Per-query ClickHouse execution
                settings, equivalent to a trailing ``SETTINGS ...`` clause on
                the SQL (e.g. ``{"max_execution_time": 10}`` makes the server
                abort this query once ~10s elapse — checked at data-processing
                checkpoints, not a hard wall-clock kill — with a
                TIMEOUT_EXCEEDED error, which surfaces here as a raised
                exception). Scoped to the single query: other queries, the
                session, and the server config are unaffected. ``None`` means
                server/session defaults.

        Returns:
            QueryResult: The clickhouse-connect query result.
        """
        return self._client.query(query, parameters=parameters, settings=settings)

    def close(self) -> None:
        """Close the client connection."""
        self._client.close()


# Singleton instance
_client: ClickHouseClient | None = None


def get_clickhouse_client() -> ClickHouseClient:
    """Get or create the singleton ClickHouse client."""
    global _client
    if _client is None:
        _client = ClickHouseClient.from_settings()
    return _client
