"""ClickHouse client using clickhouse-connect."""

import os
from datetime import datetime, timezone
from typing import Any

import clickhouse_connect
from clickhouse_connect.driver.client import Client


class ClickHouseClient:
    """ClickHouse client wrapper for trace data operations."""

    def __init__(self, client: Client):
        self._client = client

    @classmethod
    def from_env(cls) -> "ClickHouseClient":
        """Create client from environment variables."""
        port = os.getenv("CLICKHOUSE_HTTP_PORT") or os.getenv("CLICKHOUSE_PORT", "8123")
        client = clickhouse_connect.get_client(
            host=os.getenv("CLICKHOUSE_HOST", "localhost"),
            port=int(port),
            username=os.getenv("CLICKHOUSE_USER", "clickhouse"),
            password=os.getenv("CLICKHOUSE_PASSWORD", "clickhouse"),
            database=os.getenv("CLICKHOUSE_DATABASE", "default"),
        )
        return cls(client)

    def insert_traces_batch(self, traces: list[dict[str, Any]]) -> None:
        """Insert multiple trace records."""
        if not traces:
            return

        now = datetime.now(timezone.utc)
        rows = []
        for t in traces:
            rows.append([
                t["trace_id"],
                t["project_id"],
                t["trace_start_time"],
                t["name"],
                t.get("user_id"),
                t.get("session_id"),
                t.get("environment", "default"),
                t.get("release"),
                t.get("input"),
                t.get("output"),
                now,  # ch_create_time
                now,  # ch_update_time
            ])

        self._client.insert(
            "traces",
            rows,
            column_names=[
                "trace_id", "project_id", "trace_start_time", "name", "user_id", "session_id",
                "environment", "release", "input", "output",
                "ch_create_time", "ch_update_time",
            ],
        )

    def insert_spans_batch(self, spans: list[dict[str, Any]]) -> None:
        """Insert multiple span records."""
        if not spans:
            return

        now = datetime.now(timezone.utc)
        rows = []
        for s in spans:
            rows.append([
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
                s.get("input"),
                s.get("output"),
                s.get("environment", "default"),
                now,  # ch_create_time
                now,  # ch_update_time
            ])

        self._client.insert(
            "spans",
            rows,
            column_names=[
                "span_id", "trace_id", "parent_span_id", "project_id",
                "span_start_time", "span_end_time",
                "name", "span_kind", "status", "status_message",
                "model_name", "cost",
                "input", "output",
                "environment", "ch_create_time", "ch_update_time",
            ],
        )

    def close(self) -> None:
        """Close the client connection."""
        self._client.close()


# Singleton instance
_client: ClickHouseClient | None = None


def get_clickhouse_client() -> ClickHouseClient:
    """Get or create the singleton ClickHouse client."""
    global _client
    if _client is None:
        _client = ClickHouseClient.from_env()
    return _client
