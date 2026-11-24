"""Static checks on the migration that adds ``spans.tags`` (#1748).

The column holds a span's tags as an array, defaults to an empty array so existing rows
read as untagged, and stays out of every key so the ALTER is metadata-only.
"""

import re
from pathlib import Path

MIGRATIONS_DIR = (
    Path(__file__).resolve().parents[2] / "backend" / "db" / "clickhouse" / "migrations"
)
MIGRATION = MIGRATIONS_DIR / "018_add_span_tags.sql"


def _sections() -> tuple[str, str]:
    text = MIGRATION.read_text(encoding="utf-8")
    assert "-- +goose Up" in text and "-- +goose Down" in text
    up, _, down = text.partition("-- +goose Down")

    def strip(section: str) -> str:
        return "\n".join(
            line for line in section.splitlines() if not line.lstrip().startswith("--")
        )

    return strip(up), strip(down)


def test_up_adds_an_array_column_defaulting_to_empty():
    up, _ = _sections()
    assert re.search(
        r"ALTER TABLE spans\s+ADD COLUMN IF NOT EXISTS tags\s+"
        r"Array\(LowCardinality\(String\)\)\s+DEFAULT \[\]\s*;",
        up,
    )


def test_down_drops_the_column():
    _, down = _sections()
    assert re.search(r"ALTER TABLE spans\s+DROP COLUMN IF EXISTS tags\s*;", down)


def test_only_the_spans_table_is_touched():
    """Tags live on spans, never on the trace row: a later traces-row version
    (ReplacingMergeTree) would otherwise overwrite the tags an earlier batch set."""
    up, down = _sections()
    for section in (up, down):
        assert "traces" not in section
        statements = [s for s in section.split(";") if s.strip()]
        assert all("ALTER TABLE spans" in s for s in statements)


def test_the_add_column_is_metadata_only():
    """No projection rebuild and no MATERIALIZE: either would rewrite parts of the
    largest table at deploy time."""
    up, _ = _sections()
    assert "PROJECTION" not in up
    assert "MATERIALIZE" not in up
    assert "MODIFY ORDER BY" not in up
