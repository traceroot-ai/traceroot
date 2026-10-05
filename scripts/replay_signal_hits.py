"""Replay the signal hits the assignment worker gave up on.

The worker gives up on a hit only after repeated unusable model answers (never
for an outage), writing a ClickHouse signal_assignments row with an empty
signal_id. Dry-run by default: lists a project's given-up hits that are still
within the worker's seven-day lookback (older ones are not read again).
--apply deletes their give-up rows and marks their detectors pending in
Postgres, so the worker's sweeper assigns them again within a few minutes.

Configure DATABASE_URL and the existing CLICKHOUSE_* settings, then run with
--project-id (and --detector-id to limit it to one detector).
"""

import argparse
import os
import sys
from datetime import UTC, datetime, timedelta
from pathlib import Path
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

# Run directly, `db` resolves only with `backend` on sys.path.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "backend"))

import psycopg2
from psycopg2 import sql

from db.clickhouse.client import get_clickhouse_client

# The worker's WAITING_LOOKBACK_MS: hits detected before this are never read.
LOOKBACK = timedelta(days=7)


def postgres_connection():
    url = urlsplit(os.environ["DATABASE_URL"])
    params = dict(parse_qsl(url.query))
    schema = params.pop("schema", "public")
    connection = psycopg2.connect(urlunsplit(url._replace(query=urlencode(params))))
    with connection.cursor() as cursor:
        cursor.execute(sql.SQL("SET search_path TO {}").format(sql.Identifier(schema)))
    connection.commit()
    return connection


def given_up_hits(ch, project_id, detector_id=None, now=None):
    """(detector_id, run_id) of the project's given-up hits detected within the lookback."""
    since = (now or datetime.now(UTC)) - LOOKBACK
    result = ch.query(
        """
        SELECT detector_id, run_id
        FROM signal_assignments FINAL
        WHERE project_id = {project_id:String}
          AND signal_id = ''
          AND ({detector_id:String} = '' OR detector_id = {detector_id:String})
          AND run_id IN (
              SELECT run_id FROM detector_runs
              WHERE project_id = {project_id:String}
                AND timestamp >= {since:DateTime64(3)}
          )
        ORDER BY detector_id, run_id
        """,
        parameters={"project_id": project_id, "detector_id": detector_id or "", "since": since},
    )
    return [(d, r) for d, r in result.result_rows]


def replay(pg, ch, project_id, detector_id=None, *, apply=False, now=None):
    """List (and with apply, replay) the given-up hits; returns them."""
    hits = given_up_hits(ch, project_id, detector_id, now)
    if not apply or not hits:
        return hits
    ch.delete_given_up_signal_assignments(project_id, [r for _, r in hits])
    detectors = sorted({d for d, _ in hits})
    with pg.cursor() as cursor:
        # The sweeper re-enqueues a detector marked pending; raw timestamps, as
        # the worker writes them, so the detector's update time stays put.
        cursor.execute(
            "UPDATE detectors SET assignment_pending_at = %s WHERE project_id = %s AND id = ANY(%s)",
            ((now or datetime.now(UTC)).replace(tzinfo=None), project_id, detectors),
        )
    pg.commit()
    return hits


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--project-id", required=True)
    parser.add_argument("--detector-id")
    parser.add_argument("--apply", action="store_true", help="replay; without it, only list")
    args = parser.parse_args()
    pg = postgres_connection()
    try:
        hits = replay(
            pg, get_clickhouse_client(), args.project_id, args.detector_id, apply=args.apply
        )
    finally:
        pg.close()
    for detector_id, run_id in hits:
        print(f"{detector_id}\t{run_id}")
    verb = "replayed" if args.apply else "would replay (dry run; pass --apply)"
    print(f"{len(hits)} given-up hit(s) {verb}", file=sys.stderr)


if __name__ == "__main__":
    main()
