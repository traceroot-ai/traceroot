"""Recover ingestion dates from retained spans. Dry-run unless --apply is supplied.

    PYTHONPATH=backend uv run python scripts/backfill_project_ingestion.py
    PYTHONPATH=backend uv run python scripts/backfill_project_ingestion.py --apply

Run after the project timestamp migration. Existing newer dates are preserved.
Projects without retained spans remain unknown; creation and rename times are not substitutes.
"""

import argparse

from db.clickhouse.client import get_clickhouse_client
from db.postgres import get_pg_pool
from db.project_ingestion import record_project_ingestion

PROJECT_BATCH_SIZE = 500


def backfill(*, apply: bool = False) -> int:
    """Recover the latest receive time visible in each active project's retained spans.

    Args:
        apply (bool): Persist recovered dates when True; otherwise only count them.

    Returns:
        int: Number of active projects with retained telemetry.
    """
    pool = get_pg_pool()
    conn = pool.getconn()
    broken = False
    try:
        with conn.cursor() as cursor:
            cursor.execute("SELECT id FROM projects WHERE delete_time IS NULL ORDER BY id")
            ids = [row[0] for row in cursor.fetchall()]
    except Exception:
        broken = True
        raise
    finally:
        try:
            conn.rollback()
        except Exception:
            broken = True
        pool.putconn(conn, close=broken)
    if not ids:
        return 0
    ch = get_clickhouse_client()
    count = 0
    for offset in range(0, len(ids), PROJECT_BATCH_SIZE):
        rows = ch.query(
            "SELECT project_id, max(ch_update_time) FROM spans "
            "WHERE project_id IN {ids:Array(String)} GROUP BY project_id",
            parameters={"ids": ids[offset : offset + PROJECT_BATCH_SIZE]},
        ).result_rows
        for project_id, received_at in rows:
            if apply:
                record_project_ingestion({project_id}, received_at)
            count += 1
    return count


def main() -> None:
    """Run a dry run or apply the backfill according to the command-line flag."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apply", action="store_true", help="persist recovered ingestion dates")
    args = parser.parse_args()
    count = backfill(apply=args.apply)
    print(f"{'Applied' if args.apply else 'Dry run:'} ingestion dates for {count} projects")


if __name__ == "__main__":
    main()
