"""Guard the raw-SQL shadow of the Prisma-owned detector tables.

DetectorReaderService queries Postgres tables whose schema is owned by the
Next.js app (frontend/packages/core/prisma/schema.prisma). A Prisma migration
that renames or drops a column would break that SQL only at runtime; this test
turns such drift into a test failure by asserting every column the service
references still exists in the Prisma schema.
"""

import re
from pathlib import Path

import pytest

SCHEMA_PATH = (
    Path(__file__).resolve().parents[2]
    / "frontend"
    / "packages"
    / "core"
    / "prisma"
    / "schema.prisma"
)

# Columns referenced by DetectorReaderService's SQL, by mapped table name.
# Update together with the service's queries.
REFERENCED_COLUMNS = {
    "detectors": {
        "id",
        "project_id",
        "name",
        "template",
        "prompt",
        "output_schema",
        "sample_rate",
        "enabled",
        "enable_rca",
        "detection_model",
        "detection_provider",
        "detection_source",
        "create_time",
        "update_time",
    },
    "detector_triggers": {"detector_id", "conditions"},
    "detector_rcas": {"finding_id", "project_id", "status", "result"},
}


def _model_columns(schema_text: str, table: str) -> set[str]:
    """Extract a mapped table's column names from the Prisma schema text.

    Args:
        schema_text (str): Full contents of schema.prisma.
        table (str): Postgres table name (the ``@@map`` value).

    Returns:
        set[str]: Column names — the ``@map`` value when present, else the
        Prisma field name. Relation fields are included harmlessly (the
        assertion only checks the referenced set is a subset).
    """
    for body in re.findall(r"model\s+\w+\s*\{(.*?)\n\}", schema_text, re.DOTALL):
        if not re.search(rf'@@map\("{table}"\)', body):
            continue
        columns: set[str] = set()
        for line in body.splitlines():
            line = line.strip()
            if not line or line.startswith(("@@", "//")):
                continue
            field = re.match(r"(\w+)\s+\S+", line)
            if not field:
                continue
            mapped = re.search(r'@map\("([^"]+)"\)', line)
            columns.add(mapped.group(1) if mapped else field.group(1))
        return columns
    raise AssertionError(f"no Prisma model maps to table {table!r}")


@pytest.mark.parametrize("table", sorted(REFERENCED_COLUMNS))
def test_reader_sql_columns_exist_in_prisma_schema(table):
    """Every column the reader's SQL references exists in the Prisma schema."""
    schema_text = SCHEMA_PATH.read_text(encoding="utf-8")
    missing = REFERENCED_COLUMNS[table] - _model_columns(schema_text, table)
    assert not missing, (
        f"DetectorReaderService references columns missing from Prisma table "
        f"{table!r}: {sorted(missing)} — update the service SQL and this list "
        f"together with the schema migration"
    )
