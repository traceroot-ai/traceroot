"""The spans no-I/O projection must carry every column its readers touch.

Migration 005 built `spans_no_io_by_start_time` to serve time-ranged span
reads that never open the input/output/metadata blobs: its
`ORDER BY (project_id, span_start_time, ...)` repairs the weak time pruning of
the base table, whose sort key buries `span_start_time` behind `trace_id`.

ClickHouse will only use a projection for a query whose every referenced
column the projection carries. So a column added to `spans` after 005 does not
merely miss the projection's sort key — it disqualifies the projection for
every read that then references the new column, and those reads silently fall
back to the base table's slow path.

That is what migration 006 did with `source`. Its ALTER is metadata-only
because `source` sits outside every sort and partition key (guarded by
test_source_migration_is_metadata_only) — but sitting outside the projection's
*column list* is a different fact with a cost, and nothing caught it.

These assertions replay the migration files, so the next ALTER ADD COLUMN that
forgets the projection fails here instead of quietly buying a base-table scan.
"""

import re
from pathlib import Path

MIGRATIONS_DIR = (
    Path(__file__).resolve().parents[2] / "backend" / "db" / "clickhouse" / "migrations"
)

# The blobs the no-I/O projection exists to avoid reading. Everything else on
# `spans` belongs in it; these three deliberately do not.
IO_COLUMNS = frozenset({"input", "output", "metadata"})

# Entries in a CREATE TABLE body that declare something other than a column.
_NON_COLUMN_KEYWORDS = frozenset({"PROJECTION", "INDEX", "CONSTRAINT", "PRIMARY"})


def _migration_files() -> list[Path]:
    """Every migration, in the order goose applies them (numeric filename prefix)."""
    files = sorted(MIGRATIONS_DIR.glob("*.sql"))
    assert files, f"no migrations found in {MIGRATIONS_DIR}"
    return files


def _up_section(sql: str) -> str:
    """The goose Up half of a migration, with `--` comments stripped.

    Down sections are excluded deliberately: 005's Down re-creates `spans_v2`
    without a projection, and counting it would model a schema that never
    exists on a migrated database.
    """
    up, _, _down = sql.partition("-- +goose Down")
    assert "-- +goose Up" in up, "migration must declare a goose Up section"
    return re.sub(r"--[^\n]*", "", up)


def _paren_body(text: str, open_idx: int) -> str:
    """Contents of the parenthesis group that opens at `open_idx`, nesting included."""
    assert text[open_idx] == "(", "expected an opening parenthesis"
    depth = 0
    for i in range(open_idx, len(text)):
        if text[i] == "(":
            depth += 1
        elif text[i] == ")":
            depth -= 1
            if depth == 0:
                return text[open_idx + 1 : i]
    raise AssertionError("unbalanced parentheses in migration SQL")


def _split_top_level(body: str) -> list[str]:
    """Split on commas that are not inside a nested parenthesis group."""
    parts, depth, current = [], 0, []
    for char in body:
        if char == "(":
            depth += 1
        elif char == ")":
            depth -= 1
        if char == "," and depth == 0:
            parts.append("".join(current))
            current = []
        else:
            current.append(char)
    parts.append("".join(current))
    return [part.strip() for part in parts if part.strip()]


def _create_table_columns(up_sql: str, table: str) -> list[str] | None:
    """Column names declared by `CREATE TABLE <table>` in `up_sql`, or None.

    Non-column entries (a PROJECTION, INDEX, CONSTRAINT or PRIMARY KEY clause)
    are skipped; a projection body carries commas of its own, which is why the
    split is depth-aware.
    """
    match = re.search(rf"CREATE TABLE (?:IF NOT EXISTS )?{table}\b", up_sql)
    if not match:
        return None
    open_idx = up_sql.index("(", match.end())
    entries = _split_top_level(_paren_body(up_sql, open_idx))
    return [
        entry.split()[0]
        for entry in entries
        if entry.split()[0].upper() not in _NON_COLUMN_KEYWORDS
    ]


def _projection_events(up_sql: str) -> list[tuple[int, str, set[str] | None]]:
    """Projection declarations and drops in `up_sql`, in statement order.

    Each event is `(position, name, columns)` — `columns` is the SELECT list for
    a declaration and None for a drop. Order within a file matters: a migration
    that drops a leftover name before declaring it under the same name would
    otherwise replay as a net removal.

    Declarations cover both forms: a `PROJECTION name (...)` inside a CREATE
    TABLE body and a standalone `ALTER TABLE ... ADD PROJECTION name (...)`. The
    `(?=\\()` lookahead is what separates them from a drop, which names a
    projection with no body following.
    """
    events: list[tuple[int, str, set[str] | None]] = []

    for match in re.finditer(r"\bPROJECTION\s+(\w+)\s*(?=\()", up_sql):
        body = _paren_body(up_sql, up_sql.index("(", match.end(1)))
        select_list = re.search(r"SELECT(.*?)ORDER BY", body, re.DOTALL)
        assert select_list, f"projection {match.group(1)} must SELECT columns and ORDER BY"
        events.append((match.start(), match.group(1), set(_split_top_level(select_list.group(1)))))

    for match in re.finditer(r"DROP PROJECTION(?: IF EXISTS)? (\w+)", up_sql):
        events.append((match.start(), match.group(1), None))

    return sorted(events, key=lambda event: event[0])


def live_spans_columns() -> set[str]:
    """Columns on `spans` after every migration has been applied.

    Starts from the last CREATE that becomes the live table (005 creates
    `spans_v2` and renames it over `spans`, so the rebuild's column list is the
    baseline, not 002's) and replays the ADD/DROP COLUMN statements that follow.
    """
    columns: list[str] = []
    for path in _migration_files():
        up = _up_section(path.read_text())
        created = _create_table_columns(up, "spans_v2") or _create_table_columns(up, "spans")
        if created is not None:
            columns = created
            continue
        for name in re.findall(r"ALTER TABLE spans\s+ADD COLUMN(?: IF NOT EXISTS)? (\w+)", up):
            if name not in columns:
                columns.append(name)
        for name in re.findall(r"ALTER TABLE spans\s+DROP COLUMN(?: IF EXISTS)? (\w+)", up):
            if name in columns:
                columns.remove(name)
    assert columns, "expected a CREATE TABLE for spans in the migrations"
    return set(columns)


def live_spans_projections() -> dict[str, set[str]]:
    """Projections on `spans` after every migration, mapped to their columns.

    Replayed in migration order: a CREATE seeds the table's projections, an ADD
    PROJECTION installs one, a DROP PROJECTION removes it. ClickHouse cannot
    rename a projection, so a rebuild that changes the column list arrives under
    a new name and retires the old one here.
    """
    projections: dict[str, set[str]] = {}
    for path in _migration_files():
        up = _up_section(path.read_text())
        if _create_table_columns(up, "spans_v2") is not None:
            projections = {}
        for _position, name, columns in _projection_events(up):
            if columns is None:
                projections.pop(name, None)
            else:
                projections[name] = columns
    return projections


def test_spans_has_exactly_one_no_io_projection():
    """One projection serves the no-I/O reads; a rebuild retires its predecessor.

    Two live projections carrying the same columns would double the write and
    storage cost of every part for no read benefit, which is the failure mode of
    adding a `_v2` and forgetting to drop the original.
    """
    projections = live_spans_projections()
    assert len(projections) == 1, (
        f"expected exactly one projection on spans, found {sorted(projections)}"
    )


def test_no_io_projection_carries_every_non_blob_column():
    """The projection's column list is the whole table minus the I/O blobs.

    A column missing here cannot be read through the projection, so ClickHouse
    refuses the projection outright for any query naming that column — the
    read falls back to the base table and its buried `span_start_time`.
    """
    columns = live_spans_columns()
    (projected,) = live_spans_projections().values()

    expected = columns - IO_COLUMNS
    missing = expected - projected
    assert not missing, (
        "columns on spans are absent from the no-I/O projection, disabling it for "
        f"every read that references them: {sorted(missing)}"
    )

    unexpected = projected - columns
    assert not unexpected, (
        f"projection carries columns that spans does not have: {sorted(unexpected)}"
    )

    carried_blobs = projected & IO_COLUMNS
    assert not carried_blobs, (
        "the projection exists to keep the I/O blobs off the read path; carrying "
        f"them defeats it: {sorted(carried_blobs)}"
    )


def test_widget_spans_base_reads_only_projection_columns():
    """The dashboard's spans scan must stay eligible for the projection.

    `_SPANS_BASE` is the exact shape the projection was built for — one project,
    a `span_start_time` window, no blob columns. It also filters
    `source = 'user'`, so every column it names has to be one the projection
    carries or the whole widget path pays a base-table scan.
    """
    from rest.services.widget_registry import _SPANS_BASE

    columns = live_spans_columns()
    (projected,) = live_spans_projections().values()

    referenced = {name for name in columns if re.search(rf"\b{name}\b", _SPANS_BASE)}
    assert "span_start_time" in referenced, "sanity: the base query is time-windowed"

    missing = referenced - projected
    assert not missing, (
        "the widget spans scan references columns the projection does not carry, so "
        f"ClickHouse cannot use it: {sorted(missing)}"
    )


def test_paren_body_handles_nesting():
    """A projection body inside a CREATE is returned whole, inner parens included."""
    text = "CREATE TABLE t (a String, PROJECTION p (SELECT a ORDER BY (a)))"
    body = _paren_body(text, text.index("("))
    assert body.startswith("a String")
    assert body.endswith("ORDER BY (a))")


def test_split_top_level_ignores_commas_inside_parens():
    """Only depth-zero commas separate entries."""
    assert _split_top_level("a, f(b, c), d") == ["a", "f(b, c)", "d"]
