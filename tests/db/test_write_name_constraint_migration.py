"""Guards the shape of the write-path name-constraint migration.

The migration backs the idempotent creates with unique indexes on
(created_by, name) / (workspace_id, name) / (project_id, name). Creating a
unique index over pre-existing duplicate rows aborts the migration, so the
file must deduplicate each table (deterministic rename) *before* its index —
and the workspace backfill must run before the workspace dedupe partitions on
the very column it fills. These are pure string/order assertions over the
migration SQL so a refactor that reorders or drops a step trips a test
instead of failing (or silently skipping dedupe) on a real database.
"""

import re
from pathlib import Path

MIGRATIONS_DIR = (
    Path(__file__).resolve().parents[2] / "frontend" / "packages" / "core" / "prisma" / "migrations"
)
MIGRATION = MIGRATIONS_DIR / "20260902000000_write_name_constraints" / "migration.sql"

INDEXES = {
    "uq_workspace_created_by_name": ('"workspaces"("created_by", "name")', "workspaces"),
    "uq_dashboard_project_name": ('"dashboards"("project_id", "name")', "dashboards"),
    "uq_project_workspace_live_name": ('"projects" ("workspace_id", "name")', "projects"),
}


def _sql() -> str:
    return MIGRATION.read_text(encoding="utf-8")


def _dedupe_block_start(sql: str, table: str) -> int:
    """Find where a table's rename-dedupe loop starts.

    Args:
        sql (str): Full migration SQL.
        table (str): Bare table name the DO block updates.

    Returns:
        int: Offset of the block's UPDATE statement; -1 when absent.
    """
    match = re.search(rf"UPDATE {table} \w+\n\s+SET name = ", sql)
    return match.start() if match else -1


def test_each_unique_index_is_created_exactly_once():
    sql = _sql()
    for name, (target, _table) in INDEXES.items():
        statements = re.findall(rf'CREATE UNIQUE INDEX "{name}"\s+ON {re.escape(target)}', sql)
        assert len(statements) == 1, f"expected exactly one CREATE UNIQUE INDEX for {name}"


def test_project_index_is_partial_on_live_rows():
    sql = _sql()
    match = re.search(
        r'CREATE UNIQUE INDEX "uq_project_workspace_live_name"\s+'
        r'ON "projects" \("workspace_id", "name"\)\s+'
        r'WHERE "delete_time" IS NULL;',
        sql,
    )
    assert match, "the project unique index must be partial: WHERE delete_time IS NULL"


def test_dedupe_runs_before_each_index_and_backfill_before_dedupe():
    sql = _sql()
    backfill = sql.find('SET "created_by" = (')
    assert backfill != -1, "workspaces.created_by backfill missing"

    for name, (_target, table) in INDEXES.items():
        dedupe = _dedupe_block_start(sql, table)
        index = sql.find(f'CREATE UNIQUE INDEX "{name}"')
        assert dedupe != -1, f"missing rename-dedupe loop for {table}"
        assert index != -1, f"missing CREATE UNIQUE INDEX {name}"
        assert dedupe < index, f"{table} dedupe must run before its unique index"

    workspace_dedupe = _dedupe_block_start(sql, "workspaces")
    assert backfill < workspace_dedupe, (
        "created_by backfill must run before the workspace dedupe partitions on it"
    )


def test_dedupe_scopes_match_index_scopes():
    """Each dedupe partitions exactly the columns its index enforces, and the
    project dedupe only touches live rows (soft-deleted names stay put)."""
    sql = _sql()
    assert "PARTITION BY created_by, name" in sql
    assert "PARTITION BY workspace_id, name" in sql
    assert "PARTITION BY project_id, name" in sql
    project_block = sql[
        _dedupe_block_start(sql, "projects") - 500 : _dedupe_block_start(sql, "projects")
    ]
    assert "WHERE delete_time IS NULL" in project_block, (
        "the project dedupe must rank live rows only, mirroring the partial index"
    )


def test_schema_declares_the_expressible_uniques():
    """The two non-partial indexes are declared in schema.prisma (so Prisma's
    client and future diffs know them); the partial one cannot be, and must
    stay raw SQL in the migration."""
    schema = (MIGRATIONS_DIR.parent / "schema.prisma").read_text(encoding="utf-8")
    assert 'map: "uq_workspace_created_by_name"' in schema
    assert 'map: "uq_dashboard_project_name"' in schema
    assert "uq_project_workspace_live_name" not in schema.replace(
        "// A partial unique index uq_project_workspace_live_name", ""
    ), "the partial project index must not be declared as a Prisma index"
