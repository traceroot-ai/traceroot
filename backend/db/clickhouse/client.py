"""ClickHouse client using clickhouse-connect."""

from datetime import UTC, datetime
from typing import Any

import clickhouse_connect
from clickhouse_connect.driver.client import Client

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

    def query(self, query: str, parameters: dict[str, Any] | None = None):
        """Execute a query and return the result."""
        return self._client.query(query, parameters=parameters)

    def command(self, cmd: str, parameters: dict[str, Any] | None = None) -> None:
        """Execute a DDL/DML command (e.g. ALTER TABLE DELETE mutation)."""
        self._client.command(cmd, parameters=parameters)

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
