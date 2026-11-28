"""Add every existing user to the public demo workspace as a VIEWER.

New users join the demo workspace at sign-up and at each login (see
frontend/ui/src/lib/demo-workspace.ts). Run this once when the demo workspace
is created, so users who do not log in soon can see it too.

Dry-run by default: it prints how many users would join. --apply writes. A user
who is already a member keeps their role (an admin is never lowered to VIEWER),
so the script is safe to run again. Configure DATABASE_URL.

    python scripts/backfill_demo_workspace_members.py --workspace-id <id>
    python scripts/backfill_demo_workspace_members.py --workspace-id <id> --apply
"""

import argparse
import os
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

# Count users missing from the demo without loading every user into memory.
MISSING_USERS_SQL = """
    SELECT COUNT(*)
    FROM users u
    WHERE NOT EXISTS (
        SELECT 1 FROM workspace_members m
        WHERE m.workspace_id = %(workspace_id)s AND m.user_id = u.id
    )
"""

INSERT_SQL = """
    INSERT INTO workspace_members (id, workspace_id, user_id, role, create_time, update_time)
    SELECT gen_random_uuid()::text, %(workspace_id)s, u.id, 'VIEWER', now(), now()
    FROM users u
    ON CONFLICT (workspace_id, user_id) DO NOTHING
"""


def postgres_connection():
    import psycopg2
    from psycopg2 import sql

    url = urlsplit(os.environ["DATABASE_URL"])
    params = dict(parse_qsl(url.query))
    schema = params.pop("schema", "public")
    connection = psycopg2.connect(urlunsplit(url._replace(query=urlencode(params))))
    with connection.cursor() as cursor:
        cursor.execute(sql.SQL("SET search_path TO {}").format(sql.Identifier(schema)))
    connection.commit()
    return connection


def backfill(pg, workspace_id, *, apply=False):
    """Add the missing users. Returns (users missing before, users added)."""
    with pg.cursor() as cursor:
        cursor.execute(
            "SELECT 1 FROM workspaces WHERE id = %(workspace_id)s", {"workspace_id": workspace_id}
        )
        if cursor.fetchone() is None:
            raise SystemExit(f"workspace {workspace_id} does not exist")
        cursor.execute(MISSING_USERS_SQL, {"workspace_id": workspace_id})
        missing = cursor.fetchone()[0]
        added = 0
        if apply and missing:
            cursor.execute(INSERT_SQL, {"workspace_id": workspace_id})
            added = cursor.rowcount
    if apply:
        pg.commit()
    else:
        pg.rollback()
    return missing, added


def main():
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument(
        "--workspace-id", required=True, help="the demo workspace (DEMO_WORKSPACE_ID)"
    )
    parser.add_argument(
        "--apply", action="store_true", help="write the memberships (default: dry run)"
    )
    args = parser.parse_args()

    pg = postgres_connection()
    try:
        missing, added = backfill(pg, args.workspace_id, apply=args.apply)
    finally:
        pg.close()
    if args.apply:
        print(f"added {added} users to the demo workspace as VIEWER")
    else:
        print(f"dry run: {missing} users would join the demo workspace as VIEWER (use --apply)")


if __name__ == "__main__":
    main()
