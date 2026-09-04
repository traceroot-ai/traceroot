"""ClickHouse client using clickhouse-connect."""

import logging
from datetime import UTC, datetime
from typing import Any

import clickhouse_connect
from clickhouse_connect.driver.client import Client

from shared.config import settings

logger = logging.getLogger(__name__)


class ClickHouseClient:
    """ClickHouse client wrapper for trace data operations."""

    def __init__(self, client: Client):
        self._client = client

    @classmethod
    def from_settings(cls) -> "ClickHouseClient":
        """Create client from centralized settings (full-privilege user)."""
        ch = settings.clickhouse
        return cls._build(ch.user, ch.password)

    @classmethod
    def readonly_from_settings(cls) -> "ClickHouseClient":
        """Create a client authenticated as the read-only SQL gateway user.

        Raises if ``CLICKHOUSE_RO_USER`` is unset — callers wanting the
        cloud-fatal / self-host-fallback behavior must use
        ``get_readonly_clickhouse_client`` instead.
        """
        ch = settings.clickhouse
        if not ch.ro_user:
            raise RuntimeError(
                "readonly_from_settings() requires CLICKHOUSE_RO_USER to be set; "
                "use get_readonly_clickhouse_client() for the configured fallback behavior."
            )
        return cls._build(ch.ro_user, ch.ro_password or "")

    @classmethod
    def _build(cls, username: str, password: str) -> "ClickHouseClient":
        ch = settings.clickhouse
        client = clickhouse_connect.get_client(
            host=ch.host,
            port=ch.port,
            username=username,
            password=password,
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
    ):
        """Execute a query and return the result.

        ``parameters`` are clickhouse-connect ``{name:Type}`` binds; ``settings``
        are per-query ClickHouse settings (note: a ``readonly=1`` user cannot apply
        per-query settings).
        """
        return self._client.query(query, parameters=parameters, settings=settings)

    def close(self) -> None:
        """Close the client connection."""
        self._client.close()


# Singleton instances
_client: ClickHouseClient | None = None
_ro_client: ClickHouseClient | None = None


def get_clickhouse_client() -> ClickHouseClient:
    """Get or create the singleton ClickHouse client (full-privilege user)."""
    global _client
    if _client is None:
        _client = ClickHouseClient.from_settings()
    return _client


def get_readonly_clickhouse_client() -> ClickHouseClient:
    """Get or create the singleton read-only ClickHouse client for the SQL gateway.

    Uses the dedicated read-only user (``CLICKHOUSE_RO_USER`` / ``CLICKHOUSE_RO_PASSWORD``)
    when configured. When it is NOT configured:

    * **Cloud mode** (billing enabled, ``ENABLE_BILLING`` != ``"false"``): fail fast —
      we refuse to run user SQL through a privileged client in a multi-tenant deployment.
    * **Self-host / dev** (``ENABLE_BILLING=false``): fall back to the default client and
      log a loud warning.

    Tenant isolation still depends on the application binding the authenticated
    project_id into the view call; DB grants do not enforce the tenant choice.
    """
    global _ro_client
    if _ro_client is not None:
        return _ro_client

    if settings.clickhouse.ro_user:
        _ro_client = ClickHouseClient.readonly_from_settings()
        return _ro_client

    # No read-only user configured. Lazy import avoids coupling this module to the
    # enterprise license gate at import time.
    from ee.license import is_billing_enabled

    if is_billing_enabled():
        raise RuntimeError(
            "CLICKHOUSE_RO_USER is required in cloud mode (ENABLE_BILLING != 'false') for the "
            "public SQL gateway, but it is not configured. Refusing to execute user SQL through "
            "a privileged ClickHouse client."
        )

    logger.warning(
        "SQL gateway FALLBACK: CLICKHOUSE_RO_USER is not set; using the default (privileged) "
        "ClickHouse client. This is acceptable for local/dev/self-host only — cloud deployments "
        "MUST set CLICKHOUSE_RO_USER."
    )
    _ro_client = get_clickhouse_client()
    return _ro_client
