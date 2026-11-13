"""Project ingestion timestamps against an explicitly selected disposable Postgres database."""

import os
import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime, timedelta
from pathlib import Path
from unittest.mock import MagicMock

import psycopg2
import pytest
from psycopg2 import sql
from psycopg2.pool import ThreadedConnectionPool

from db.project_ingestion import record_project_ingestion
from tests.fixtures.otel_payloads import make_otel_payload, make_span
from worker.ingest_tasks import process_s3_traces

DATABASE = os.environ.get("PROJECT_INGESTION_TEST_DATABASE_URL")
pytestmark = [
    pytest.mark.integration,
    pytest.mark.skipif(not DATABASE, reason="requires a disposable Postgres database"),
]
MIGRATION = Path(__file__).resolve().parents[2] / (
    "frontend/packages/core/prisma/migrations/"
    "20261113000000_add_project_last_ingested_at/migration.sql"
)
T0 = datetime(2026, 11, 13, 12, 0, tzinfo=UTC)


@pytest.fixture()
def pg(monkeypatch):
    schema = f"ingestion_{uuid.uuid4().hex}"
    admin = psycopg2.connect(DATABASE)
    admin.autocommit = True
    with admin.cursor() as cursor:
        cursor.execute(sql.SQL("CREATE SCHEMA {}").format(sql.Identifier(schema)))
    pool = ThreadedConnectionPool(1, 8, DATABASE, options=f"-c search_path={schema}")
    connection = pool.getconn()
    with connection.cursor() as cursor:
        cursor.execute("CREATE TABLE projects (id text PRIMARY KEY, delete_time timestamp)")
        cursor.execute(MIGRATION.read_text())
        cursor.execute("INSERT INTO projects (id) VALUES ('p1'), ('p2'), ('deleted')")
        cursor.execute("UPDATE projects SET delete_time = now() WHERE id = 'deleted'")
    connection.commit()
    pool.putconn(connection)
    monkeypatch.setattr("db.project_ingestion.get_pg_pool", lambda: pool)

    def read():
        conn = pool.getconn()
        try:
            with conn.cursor() as cursor:
                cursor.execute("SELECT id, last_ingested_at FROM projects")
                return dict(cursor.fetchall())
        finally:
            conn.rollback()
            pool.putconn(conn)

    yield read
    pool.closeall()
    with admin.cursor() as cursor:
        cursor.execute(sql.SQL("DROP SCHEMA {} CASCADE").format(sql.Identifier(schema)))
    admin.close()


def test_migration_leaves_unknown_dates_null(pg):
    assert pg() == {"p1": None, "p2": None, "deleted": None}


def test_updates_are_project_scoped_monotonic_and_ignore_deleted_projects(pg):
    record_project_ingestion("p1", T0 + timedelta(seconds=5))
    record_project_ingestion("p1", T0)
    for project_id in ("p2", "deleted", "missing"):
        record_project_ingestion(project_id, T0)
    assert pg() == {
        "p1": datetime(2026, 11, 13, 12, 0, 5),
        "p2": datetime(2026, 11, 13, 12, 0),
        "deleted": None,
    }


def test_concurrent_snapshots_keep_the_latest_receive_time(pg):
    offsets = [3, 1, 7, 0, 6, 2, 5, 4]
    with ThreadPoolExecutor(max_workers=8) as executor:
        list(
            executor.map(
                lambda n: record_project_ingestion("p1", T0 + timedelta(seconds=n)), offsets
            )
        )
    assert pg()["p1"] == datetime(2026, 11, 13, 12, 0, 7)


def test_task_persists_receive_time_for_existing_trace_snapshots(pg, monkeypatch):
    s3, ch = MagicMock(), MagicMock()
    ch.query.return_value.result_rows = [("aa" * 16,)]
    monkeypatch.setattr("rest.services.s3.get_s3_service", lambda: s3)
    monkeypatch.setattr("db.clickhouse.client.get_clickhouse_client", lambda: ch)
    monkeypatch.setattr("worker.detector_tasks.enqueue_detector_runs", MagicMock())
    monkeypatch.setattr("worker.ingest_tasks._publish_live_spans", MagicMock())

    for parent, timestamp in [(None, T0), ("bb" * 8, T0 + timedelta(seconds=5)), ("bb" * 8, T0)]:
        s3.download_json.return_value = make_otel_payload(
            [make_span("aa" * 16, "cc" * 8, parent_span_id_hex=parent)]
        )
        process_s3_traces(s3_key="batch.json", project_id="p1", received_at=timestamp.isoformat())
    assert pg()["p1"] == datetime(2026, 11, 13, 12, 0, 5)
    assert pg()["p2"] is None
    assert ch.insert_spans_batch.call_count == 3
    assert ch.insert_traces_batch.call_count == 1


def test_failed_storage_does_not_mark_the_project_updated(pg, monkeypatch):
    s3, ch = MagicMock(), MagicMock()
    s3.download_json.return_value = make_otel_payload([make_span("aa" * 16, "bb" * 8)])
    ch.insert_spans_batch.side_effect = RuntimeError("storage unavailable")
    monkeypatch.setattr("rest.services.s3.get_s3_service", lambda: s3)
    monkeypatch.setattr("db.clickhouse.client.get_clickhouse_client", lambda: ch)
    with pytest.raises(RuntimeError, match="storage unavailable"):
        process_s3_traces(s3_key="batch.json", project_id="p1", received_at=T0.isoformat())
    assert pg()["p1"] is None


@pytest.mark.parametrize("endpoint", ["/api/v1/internal/traces", "/api/v1/internal/traces/agent"])
def test_self_traces_leave_customer_ingestion_time_unchanged(pg, monkeypatch, endpoint):
    from fastapi.testclient import TestClient
    from opentelemetry.proto.collector.trace.v1.trace_service_pb2 import ExportTraceServiceRequest

    from rest.main import app
    from shared.config import settings

    monkeypatch.setattr(settings, "internal_api_secret", "test-secret")
    ch = MagicMock()
    monkeypatch.setattr("rest.routers.internal.ingest.get_clickhouse_client", lambda: ch)
    request = ExportTraceServiceRequest()
    span = request.resource_spans.add().scope_spans.add().spans.add()
    span.trace_id = bytes.fromhex("aa" * 16)
    span.span_id = bytes.fromhex("bb" * 8)
    span.name = "platform run"
    span.start_time_unix_nano = 1700000000000000000
    span.end_time_unix_nano = 1700000001000000000
    response = TestClient(app).post(
        endpoint,
        content=request.SerializeToString(),
        headers={"X-Internal-Secret": "test-secret", "X-Project-Id": "p1"},
    )
    assert response.status_code == 200
    ch.insert_spans_batch.assert_called_once()
    assert pg()["p1"] is None
