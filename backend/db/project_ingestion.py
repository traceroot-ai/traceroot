"""Persist the receive time of successfully ingested project telemetry."""

from datetime import UTC, datetime

from db.postgres import get_pg_pool

PROJECT_INGESTION_SQL = """
    UPDATE projects
    SET last_ingested_at = %s
    WHERE id = ANY(%s) AND delete_time IS NULL
      AND (last_ingested_at IS NULL OR last_ingested_at < %s)
"""


def record_project_ingestion(project_ids: set[str], received_at: datetime) -> None:
    """Advance project ingestion times without regressing on retries or older batches.

    Failures propagate so the caller retries rather than acknowledging an unrecorded update.

    Args:
        project_ids (set[str]): Projects whose telemetry was successfully stored.
        received_at (datetime): Server receive time of the batch, in UTC.

    Returns:
        None: The timestamps have been committed.
    """
    if not project_ids:
        return
    # Prisma stores these dates as UTC timestamp-without-time-zone values.
    timestamp = received_at.replace(tzinfo=UTC) if received_at.tzinfo is None else received_at
    timestamp = timestamp.astimezone(UTC).replace(tzinfo=None)
    pool = get_pg_pool()
    conn = pool.getconn()
    broken = False
    try:
        with conn.cursor() as cursor:
            cursor.execute(PROJECT_INGESTION_SQL, (timestamp, sorted(project_ids), timestamp))
        conn.commit()
    except Exception:
        broken = True
        try:
            conn.rollback()
        except Exception:
            pass
        raise
    finally:
        pool.putconn(conn, close=broken)
