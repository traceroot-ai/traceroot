"""Repair signal trace-time snapshots from retained ClickHouse traces.

Dry-run by default. Configure DATABASE_URL and the existing CLICKHOUSE_* settings,
then run with --project-id. --apply writes only trace_start_time; --refresh-existing
also repairs snapshots changed by a late root span. Never substitutes detection time.
"""

import argparse
import os
import sys
from datetime import UTC
from pathlib import Path
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

# Run directly, `db` resolves only with `backend` on sys.path; add it here, as
# scripts/sync_public_openapi.py does, so operators need not set PYTHONPATH.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "backend"))

import psycopg2
from psycopg2 import sql

from db.clickhouse.client import get_clickhouse_client


def postgres_connection():
    url = urlsplit(os.environ["DATABASE_URL"])
    params = dict(parse_qsl(url.query))
    schema = params.pop("schema", "public")
    connection = psycopg2.connect(urlunsplit(url._replace(query=urlencode(params))))
    with connection.cursor() as cursor:
        cursor.execute(sql.SQL("SET search_path TO {}").format(sql.Identifier(schema)))
    connection.commit()  # A dry-run rollback must not reset the schema after page one.
    return connection


def latest_trace_times(ch, project_id, trace_ids):
    result = ch.query(
        """
        SELECT trace_id, argMax(trace_start_time, ch_update_time)
        FROM traces
        WHERE project_id = {project_id:String}
          AND trace_id IN {trace_ids:Array(String)}
        GROUP BY trace_id
        """,
        parameters={"project_id": project_id, "trace_ids": trace_ids},
    )
    return {
        tid: moment.astimezone(UTC).replace(tzinfo=None) if moment.tzinfo else moment
        for tid, moment in result.result_rows
    }


def repair(
    pg,
    ch,
    project_id,
    *,
    apply=False,
    refresh_existing=False,
    batch_size=500,
    lookup_batch_size=5000,
):
    """Walk ``signal_hits`` in ``batch_size`` keyset pages, repairing each page's
    snapshot from ClickHouse.

    ``traces`` has no index on ``trace_id`` alone, so every ``latest_trace_times``
    call rescans the project's whole retained partition range regardless of how
    few ids it asks for. Looking one Postgres page up at a time turns a large
    repair into one such rescan per page; instead, several pages' worth of distinct
    trace ids (up to ``lookup_batch_size``) are buffered and resolved in a single
    ClickHouse call. Postgres updates still commit (or roll back, for a dry run)
    one original page at a time, so a crash mid-repair loses at most one page of
    progress.
    """
    counts = dict(scanned=0, missing=0, changed=0, updated=0)

    def apply_page(rows, times):
        for run_id, trace_id, previous in rows:
            counts["scanned"] += 1
            moment = times.get(trace_id)
            if moment is None:
                counts["missing"] += 1
                continue
            if moment == previous:
                continue
            counts["changed"] += 1
            if apply:
                with pg.cursor() as cursor:
                    cursor.execute(
                        """UPDATE signal_hits SET trace_start_time = %s
                        WHERE project_id = %s AND run_id = %s
                          AND trace_start_time IS NOT DISTINCT FROM %s""",
                        (moment, project_id, run_id, previous),
                    )
                    counts["updated"] += cursor.rowcount
        if apply:
            pg.commit()
        else:
            pg.rollback()

    def flush(pending_pages, pending_trace_ids):
        if not pending_pages:
            return
        times = latest_trace_times(ch, project_id, list(pending_trace_ids))
        for rows in pending_pages:
            apply_page(rows, times)

    after = None
    pending_pages = []
    pending_trace_ids = set()
    while True:
        with pg.cursor() as cursor:
            cursor.execute(
                """SELECT run_id, trace_id, trace_start_time FROM signal_hits
                WHERE project_id = %s AND (%s OR trace_start_time IS NULL)
                  AND (%s IS NULL OR run_id > %s)
                ORDER BY run_id LIMIT %s""",
                (project_id, refresh_existing, after, after, batch_size),
            )
            rows = cursor.fetchall()
        if not rows:
            break
        pending_pages.append(rows)
        pending_trace_ids.update(row[1] for row in rows)
        after = rows[-1][0]
        # Bound the buffer by rows too: many hits on few traces would otherwise
        # hold every page until the end.
        if (
            len(pending_trace_ids) >= lookup_batch_size
            or len(pending_pages) * batch_size >= lookup_batch_size
        ):
            flush(pending_pages, pending_trace_ids)
            pending_pages = []
            pending_trace_ids = set()
    flush(pending_pages, pending_trace_ids)
    return counts


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--project-id", required=True)
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--refresh-existing", action="store_true")
    parser.add_argument("--batch-size", type=int, default=500)
    args = parser.parse_args()
    if not 1 <= args.batch_size <= 1000:
        parser.error("batch-size must be between 1 and 1000")
    with postgres_connection() as pg:
        counts = repair(
            pg,
            get_clickhouse_client(),
            args.project_id,
            apply=args.apply,
            refresh_existing=args.refresh_existing,
            batch_size=args.batch_size,
        )
    print("apply" if args.apply else "dry-run", counts)


if __name__ == "__main__":
    main()
