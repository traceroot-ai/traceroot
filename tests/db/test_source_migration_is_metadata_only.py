"""Guards that the spans/traces `source` column stays a metadata-only ALTER.

The `source` ADD COLUMN is cheap only while `source` sits outside every
sort key (ORDER BY), partition key (PARTITION BY), and PRIMARY KEY in the
ClickHouse schema. These are pure string assertions over the migration
files so a future key reorder that would turn the ALTER into a table
rewrite trips a test instead of a production surprise.
"""

import re
from pathlib import Path

MIGRATIONS_DIR = (
    Path(__file__).resolve().parents[2] / "backend" / "db" / "clickhouse" / "migrations"
)
SOURCE_MIGRATION = MIGRATIONS_DIR / "006_add_source_column.sql"


def _split_goose_sections(sql: str) -> tuple[str, str]:
    """Split a goose migration into its Up and Down sections.

    Args:
        sql (str): Full text of a goose migration file.

    Returns:
        tuple[str, str]: The (up, down) section bodies.
    """
    up, _, down = sql.partition("-- +goose Down")
    assert "-- +goose Up" in up, "migration must declare a goose Up section"
    return up, down


def _key_clauses(sql: str) -> list[str]:
    """Extract every sort/partition/primary-key clause from migration SQL.

    Strips `--` comments and collapses whitespace first, so a key
    declaration wrapped across lines is seen whole and commentary never
    counts. Each clause runs from its keyword to the next clause keyword,
    SETTINGS/TTL, statement end, or end of text.

    Args:
        sql (str): Migration SQL, possibly multi-line and commented.

    Returns:
        list[str]: The extracted key clauses.
    """
    no_comments = re.sub(r"--[^\n]*", "", sql)
    flat = re.sub(r"\s+", " ", no_comments)
    return re.findall(
        r"\b(?:ORDER BY|PARTITION BY|PRIMARY KEY).*?"
        r"(?=\bORDER BY\b|\bPARTITION BY\b|\bPRIMARY KEY\b|\bSETTINGS\b|\bTTL\b|;|$)",
        flat,
    )


def test_key_clauses_sees_multiline_declarations():
    """A key wrapped across lines is captured whole, continuation lines included."""
    sql = "CREATE TABLE t (a String)\nORDER BY (\n    project_id,\n    source\n);"
    clauses = _key_clauses(sql)
    assert len(clauses) == 1
    assert "source" in clauses[0]


def test_key_clauses_ignores_comments_and_splits_adjacent_clauses():
    """Commentary never counts; PARTITION BY and ORDER BY split cleanly."""
    sql = (
        "-- ORDER BY once contained source; keep it out\n"
        "CREATE TABLE t (a String)\n"
        "PARTITION BY toYYYYMM(ts)\n"
        "ORDER BY (project_id, span_id)\n"
        "SETTINGS index_granularity = 8192;"
    )
    clauses = _key_clauses(sql)
    assert len(clauses) == 2
    partition, order = clauses
    assert partition.startswith("PARTITION BY") and "toYYYYMM(ts)" in partition
    assert order.startswith("ORDER BY") and "span_id" in order
    assert not any("source" in clause for clause in clauses)


def test_key_clauses_sees_primary_key():
    """A standalone PRIMARY KEY clause is inspected too."""
    sql = "CREATE TABLE t (a String)\nPRIMARY KEY (project_id, source)\nORDER BY (project_id);"
    clauses = _key_clauses(sql)
    assert any(clause.startswith("PRIMARY KEY") and "source" in clause for clause in clauses)


def test_source_migration_adds_defaulted_column_to_both_tables():
    """Up adds source with DEFAULT 'user' to spans and traces; Down drops it."""
    sql = SOURCE_MIGRATION.read_text()
    up, down = _split_goose_sections(sql)

    for table in ("spans", "traces"):
        add = re.search(
            rf"ALTER TABLE {table}\s+ADD COLUMN IF NOT EXISTS source"
            r"\s+LowCardinality\(String\)\s+DEFAULT 'user'",
            up,
        )
        assert add, f"Up must ADD COLUMN source LowCardinality(String) DEFAULT 'user' to {table}"

        drop = re.search(rf"ALTER TABLE {table}\s+DROP COLUMN IF EXISTS source", down)
        assert drop, f"Down must DROP COLUMN source from {table}"


def test_source_stays_out_of_every_sort_and_partition_key():
    """No key clause across the migrations references source.

    Covers the live schema wherever it is defined — the original CREATEs,
    the spans sort-key rebuild (including its projection's ORDER BY), and
    any future migration added to the directory.
    """
    migration_files = sorted(MIGRATIONS_DIR.glob("*.sql"))
    assert migration_files, f"no migrations found in {MIGRATIONS_DIR}"

    clauses = [
        (path.name, clause) for path in migration_files for clause in _key_clauses(path.read_text())
    ]
    assert clauses, "expected key declarations in the migrations"

    offenders = [
        (name, clause)
        for name, clause in clauses
        if re.search(r"\bsource\b", clause, re.IGNORECASE)
    ]
    assert not offenders, (
        "source appears in a sort or partition key, so ALTERs on it are no longer "
        f"metadata-only: {offenders}"
    )
