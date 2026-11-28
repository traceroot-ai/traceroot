"""The detector tables must prune by time, and must keep their dedup key.

`detector_runs` and `detector_findings` are read through a `timestamp` window by
billing metering, the detector-window summary, the paginated runs list and the
findings list. A ClickHouse table can only prune such a window with a partition
key built from that column, because `timestamp` is deliberately absent from both
sort keys.

That absence is not an oversight. Both tables are `ReplacingMergeTree(timestamp)`
and the version column cannot also sit in the sort key: a retry writes the same
deterministic id with a newer timestamp, so a timestamp-bearing sort key would
make the retry a different row and stop it collapsing. The partition key is the
only place the time can go.

These are string assertions over the migration files, replayed in goose order, so
a future rebuild that quietly drops the partition key, or "fixes" pruning by
moving `timestamp` into a sort key, fails here instead of in production.
"""

import re
from pathlib import Path

MIGRATIONS_DIR = (
    Path(__file__).resolve().parents[2] / "backend" / "db" / "clickhouse" / "migrations"
)

DETECTOR_TABLES = ("detector_runs", "detector_findings")

# Sort keys as migration 003 wrote them, and as they must stay.
EXPECTED_SORT_KEYS = {
    "detector_runs": ("project_id", "detector_id", "run_id"),
    "detector_findings": ("project_id", "trace_id", "finding_id"),
}


def _migration_files() -> list[Path]:
    """Every migration, in the order goose applies them."""
    files = sorted(MIGRATIONS_DIR.glob("*.sql"))
    assert files, f"no migrations found in {MIGRATIONS_DIR}"
    return files


def _up_section(sql: str) -> str:
    """The goose Up half of a migration, with `--` comments stripped and flattened.

    Down sections are excluded: a rebuild's Down re-creates the pre-migration
    shape, which is never the live schema of a migrated database.
    """
    up, _, _down = sql.partition("-- +goose Down")
    assert "-- +goose Up" in up, "migration must declare a goose Up section"
    return re.sub(r"\s+", " ", re.sub(r"--[^\n]*", "", up))


def _create_statement(up_sql: str, table: str) -> str | None:
    """The `CREATE TABLE <table>` statement in `up_sql`, or None if absent."""
    match = re.search(
        rf"CREATE TABLE (?:IF NOT EXISTS )?{table}\b.*?(?=;)",
        up_sql,
    )
    return match.group(0) if match else None


def live_create_statement(table: str) -> str:
    """The CREATE that defines `table` after every migration has been applied.

    A rebuild creates `<table>_v2` and renames it over `<table>`, so the newest
    such CREATE wins over the original. Later migrations that only ALTER the
    table do not replace it.
    """
    statement = None
    for path in _migration_files():
        up = _up_section(path.read_text())
        rebuilt = _create_statement(up, f"{table}_v2")
        if rebuilt is not None:
            renamed = re.search(rf"RENAME TABLE .*?{table}_v2 TO {table}\b", up)
            assert renamed, f"{path.name} creates {table}_v2 without renaming it over {table}"
            statement = rebuilt
            continue
        created = _create_statement(up, table)
        if created is not None:
            statement = created
    assert statement, f"no CREATE TABLE found for {table}"
    return statement


def _clause(statement: str, keyword: str) -> str | None:
    """The `keyword` clause of a CREATE, up to the next clause keyword or the end."""
    match = re.search(
        rf"\b{keyword}\s+(.*?)"
        r"(?=\bORDER BY\b|\bPARTITION BY\b|\bPRIMARY KEY\b|\bSETTINGS\b|\bTTL\b|\bSAMPLE BY\b|$)",
        statement,
    )
    return match.group(1).strip() if match else None


def test_detector_tables_partition_by_month_of_timestamp():
    """Both tables carry a monthly partition key derived from `timestamp`.

    Without it the window predicates in billing metering, the window summary and
    the two list endpoints cannot prune, because `timestamp` is in neither sort
    key and a minmax skip index cannot help a column that is uncorrelated with
    the sort order.
    """
    for table in DETECTOR_TABLES:
        partition = _clause(live_create_statement(table), "PARTITION BY")
        assert partition, f"{table} has no PARTITION BY, so no timestamp window can prune"
        assert re.fullmatch(r"toYYYYMM\(timestamp\)", partition), (
            f"{table} must partition by toYYYYMM(timestamp), found {partition!r}"
        )


def test_detector_sort_keys_stay_free_of_timestamp():
    """`timestamp` must never enter a sort key of a ReplacingMergeTree keyed on it.

    It is the version column. In the sort key, a retry's newer version becomes a
    distinct row and the deterministic-id dedup stops working entirely, which is
    a correctness regression traded for the pruning the partition key already
    provides.
    """
    for table in DETECTOR_TABLES:
        statement = live_create_statement(table)
        order_by = _clause(statement, "ORDER BY")
        assert order_by, f"{table} must declare an ORDER BY"
        assert "timestamp" not in order_by, (
            f"{table} sort key contains timestamp, which breaks ReplacingMergeTree "
            f"dedup for retries: {order_by}"
        )


def test_detector_sort_keys_are_unchanged():
    """The rebuild keeps 003's sort keys exactly, so dedup identity is untouched."""
    for table, expected in EXPECTED_SORT_KEYS.items():
        order_by = _clause(live_create_statement(table), "ORDER BY")
        columns = tuple(part.strip() for part in order_by.strip("()").split(","))
        assert columns == expected, f"{table} sort key changed: {columns} != {expected}"


def test_detector_tables_stay_replacing_merge_tree_versioned_by_timestamp():
    """The engine and its version column are what make retries idempotent."""
    for table in DETECTOR_TABLES:
        statement = live_create_statement(table)
        assert re.search(r"ENGINE = ReplacingMergeTree\(timestamp\)", statement), (
            f"{table} must stay ReplacingMergeTree(timestamp): {statement}"
        )


def test_rebuild_lists_every_column_explicitly():
    """A rebuild copies columns by name, never `SELECT *`.

    A positional copy silently mis-maps the day someone adds a column between the
    CREATE and the backfill, and the wrongness is invisible until a read returns
    a value from the neighbouring column.
    """
    for path in _migration_files():
        up = _up_section(path.read_text())
        for table in DETECTOR_TABLES:
            if _create_statement(up, f"{table}_v2") is None:
                continue
            backfill = re.search(rf"INSERT INTO {table}_v2 \((.*?)\) SELECT (.*?) FROM", up)
            assert backfill, f"{path.name} rebuilds {table} without an explicit backfill"
            target = [c.strip() for c in backfill.group(1).split(",")]
            source = [c.strip() for c in backfill.group(2).split(",")]
            assert target == source, (
                f"{path.name}: {table} backfill column lists differ, {target} != {source}"
            )
