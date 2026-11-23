"""Guards legacy values restored by the Stripe meter outbox migration.

The current_usage JSON is persisted workspace data. Bad timestamps and
oversized unit strings must never abort a schema deployment or restore an
unsafe billing watermark.
"""

import re
from pathlib import Path

MIGRATION = (
    Path(__file__).resolve().parents[2]
    / "frontend"
    / "packages"
    / "core"
    / "prisma"
    / "migrations"
    / "20261110000000_stripe_meter_event_outbox"
    / "migration.sql"
)


def _sql() -> str:
    return MIGRATION.read_text(encoding="utf-8")


def test_legacy_period_timestamp_cast_is_guarded():
    """Only cast a legacy timestamp after PostgreSQL confirms it is parseable."""
    sql = _sql()
    guarded_parse = re.search(
        r'SELECT\s+CASE\s+'
        r'WHEN\s+pg_input_is_valid\(m\."raw_period_start",\s*'
        r"'timestamp with time zone'\)\s+"
        r'THEN\s+m\."raw_period_start"::timestamptz\s+'
        r'ELSE\s+NULL\s+END\s+AS\s+"period_start"\s+'
        r'\)\s+AS\s+parsed\b',
        sql,
        flags=re.IGNORECASE,
    )
    assert guarded_parse, (
        "raw_period_start must be cast only in the THEN branch of a "
        "pg_input_is_valid CASE expression"
    )
    assert sql.count('m."raw_period_start"::timestamptz') == 1


def test_invalid_or_mismatched_period_cannot_restore_watermark():
    """Malformed, missing, or mismatched legacy periods restore zero units."""
    sql = _sql()
    assert 'WHEN parsed."period_start" IS NULL' in sql
    assert '(parsed."period_start" AT TIME ZONE \'UTC\') <> p."period_start"' in sql
    assert re.search(
        r'WHEN\s+parsed\."period_start"\s+IS\s+NULL\s+OR\s+'
        r'\(parsed\."period_start"\s+AT\s+TIME\s+ZONE\s+\'UTC\'\)\s*'
        r'<> \s*p\."period_start"\s+THEN\s+0',
        sql,
        flags=re.IGNORECASE,
    )


def test_legacy_unit_text_is_normalized_before_any_numeric_cast():
    """Arbitrarily long JSON strings never reach NUMERIC or BIGINT casts."""
    sql = _sql()
    assert 'm."raw_units" ~ \'^[0-9]\'' in sql
    assert 'm."raw_units" !~ \'[^0-9]\'' in sql
    assert 'NULLIF(ltrim(m."raw_units", \'0\'), \'\')' in sql
    assert 'AS "normalized_units"' in sql
    assert 'm."raw_units"::numeric' not in sql
    assert 'm."raw_units"::bigint' not in sql
    assert 'WHERE n."normalized_units" IS NOT NULL' in sql


def test_safe_integer_cap_precedes_the_bigint_cast():
    """Long values and 16-digit values above JS safe integer are capped."""
    sql = _sql()
    too_long = sql.index('WHEN length(n."normalized_units") > 16')
    same_length_overflow = sql.index(
        'WHEN length(n."normalized_units") = 16'
    )
    bounded_cast = sql.index('ELSE n."normalized_units"::bigint')
    assert too_long < same_length_overflow < bounded_cast
    assert 'THEN 9007199254740991::bigint' in sql
    assert 'AND n."normalized_units" > \'9007199254740991\'' in sql


def test_zero_legacy_units_do_not_create_a_cursor_seed():
    """Preserve the previous behavior for zero-unit legacy watermarks."""
    sql = _sql()
    assert 'AND n."normalized_units" <> \'0\'' in sql


def test_migration_has_one_complete_transaction():
    """Prevent partial edits and duplicated SQL tails after COMMIT."""
    sql = _sql().strip()
    assert sql.startswith("BEGIN;")
    assert sql.endswith("COMMIT;")
    assert sql.count("BEGIN;") == 1
    assert sql.count("COMMIT;") == 1
    assert "ON CONFLICT (\"workspace_id\", \"meter\", \"period_start\") DO NOTHING;" in sql
