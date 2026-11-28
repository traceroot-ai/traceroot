"""Remove legacy VIEWER memberships from the configured demo workspace.

Run once during the opt-in rollout, before users can explicitly join. Old
memberships do not record consent, so viewers must join again. ADMIN and MEMBER
memberships are preserved. Dry-run is the default; --apply deletes the viewers.
Configure DATABASE_URL and DEMO_WORKSPACE_ID. See demo-workspace-rollout.md.

    python scripts/reset_demo_workspace_members.py --workspace-id <id>
    python scripts/reset_demo_workspace_members.py --workspace-id <id> --apply
"""

import argparse
import os
from typing import TYPE_CHECKING
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

if TYPE_CHECKING:
    from psycopg2.extensions import connection

COUNT_SQL = """
    SELECT COUNT(*) FROM workspace_members
    WHERE workspace_id = %(workspace_id)s AND role = 'VIEWER'
"""

DELETE_SQL = """
    DELETE FROM workspace_members
    WHERE workspace_id = %(workspace_id)s AND role = 'VIEWER'
"""


def configured_demo_workspace(workspace_id: str) -> str:
    """Validate the target against the deployment's demo configuration.

    Args:
        workspace_id (str): Requested demo workspace id.

    Returns:
        str: The validated, trimmed workspace id.
    """
    configured = os.environ.get("DEMO_WORKSPACE_ID", "").strip()
    if not configured or workspace_id.strip() != configured:
        raise ValueError("--workspace-id must match the configured DEMO_WORKSPACE_ID")
    return configured


def postgres_connection() -> "connection":
    """Connect to DATABASE_URL using its configured schema.

    Returns:
        connection: A PostgreSQL connection with the schema search path set.
    """
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


def reset_memberships(
    pg: "connection", workspace_id: str, *, apply: bool = False
) -> tuple[int, int]:
    """Count or remove demo viewers in one transaction, leaving other roles intact.

    Args:
        pg (connection): Connection to the deployment's PostgreSQL database.
        workspace_id (str): Must match DEMO_WORKSPACE_ID.
        apply (bool): Delete the viewers when true; otherwise only count them.

    Returns:
        tuple[int, int]: Viewers found and memberships actually removed.
    """
    workspace_id = configured_demo_workspace(workspace_id)
    try:
        with pg.cursor() as cursor:
            cursor.execute(
                "SELECT 1 FROM workspaces WHERE id = %(workspace_id)s",
                {"workspace_id": workspace_id},
            )
            if cursor.fetchone() is None:
                raise ValueError(f"workspace {workspace_id} does not exist")
            cursor.execute(COUNT_SQL, {"workspace_id": workspace_id})
            viewers = cursor.fetchone()[0]
            removed = 0
            if apply and viewers:
                cursor.execute(DELETE_SQL, {"workspace_id": workspace_id})
                removed = cursor.rowcount
        if apply:
            pg.commit()
        else:
            pg.rollback()
    except Exception:
        pg.rollback()
        raise
    return viewers, removed


def main() -> None:
    """Run the explicit dry-run or apply command."""
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument(
        "--workspace-id", required=True, help="must match the configured DEMO_WORKSPACE_ID"
    )
    parser.add_argument("--apply", action="store_true", help="delete viewers (default: dry run)")
    args = parser.parse_args()
    try:
        workspace_id = configured_demo_workspace(args.workspace_id)
    except ValueError as error:
        parser.error(str(error))

    pg = postgres_connection()
    try:
        viewers, removed = reset_memberships(pg, workspace_id, apply=args.apply)
    finally:
        pg.close()
    if args.apply:
        print(f"removed {removed} demo VIEWER memberships; ADMIN and MEMBER roles preserved")
    else:
        print(f"dry run: {viewers} demo VIEWER memberships would be removed (use --apply)")


if __name__ == "__main__":
    main()
