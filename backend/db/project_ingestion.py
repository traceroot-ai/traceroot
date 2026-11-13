"""Persist the receive time of successfully ingested project telemetry."""

from datetime import datetime

from db.postgres import get_pg_pool
from shared.datetime_utils import to_utc_naive

PROJECT_INGESTION_SQL = """
    SET LOCAL statement_timeout = '5s';
    UPDATE projects
    SET last_ingested_at = %s
    WHERE id = %s AND delete_time IS NULL
      AND (last_ingested_at IS NULL OR last_ingested_at < %s)
"""


def record_project_ingestion(project_id: str, received_at: datetime) -> None:
    """Advance a project's ingestion time without regressing on retries or older batches.

    The caller handles failures as advisory bookkeeping; this function owns transaction cleanup.

    Args:
        project_id (str): The project whose customer telemetry was successfully stored.
        received_at (datetime): Server receive time of the batch, in UTC.

    Returns:
        None: The timestamp has been committed.
    """
    # Prisma stores these dates as UTC timestamp-without-time-zone values.
    timestamp = to_utc_naive(received_at)
    pool = get_pg_pool()
    conn = pool.getconn()
    broken = False
    try:
        with conn.cursor() as cursor:
            cursor.execute(PROJECT_INGESTION_SQL, (timestamp, project_id, timestamp))
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
