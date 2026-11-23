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


def _strip_sql_comments(sql: str) -> str:
    """Remove SQL comments while preserving quoted strings and identifiers."""
    result: list[str] = []
    index = 0
    state = "normal"
    block_depth = 0

    while index < len(sql):
        char = sql[index]
        next_char = sql[index + 1] if index + 1 < len(sql) else ""

        if state == "normal":
            if char == "'":
                result.append(char)
                state = "single"
                index += 1
                continue
            if char == '"':
                result.append(char)
                state = "double"
                index += 1
                continue
            if char == "-" and next_char == "-":
                state = "line"
                index += 2
                continue
            if char == "/" and next_char == "*":
                state = "block"
                block_depth = 1
                index += 2
                continue
            result.append(char)
            index += 1
            continue

        if state == "line":
            if char == "\n":
                result.append(char)
                state = "normal"
            index += 1
            continue

        if state == "block":
            if char == "/" and next_char == "*":
                block_depth += 1
                index += 2
            elif char == "*" and next_char == "/":
                block_depth -= 1
                index += 2
                if block_depth == 0:
                    state = "normal"
            else:
                if char == "\n":
                    result.append(char)
                index += 1
            continue

        if state == "single":
            result.append(char)
            if char == "\\" and next_char:
                result.append(next_char)
                index += 2
                continue
            if char == "'" and next_char == "'":
                result.append(next_char)
                index += 2
                continue
            if char == "'":
                state = "normal"
            index += 1
            continue

        if state == "double":
            result.append(char)
            if char == '"' and next_char == '"':
                result.append(next_char)
                index += 2
                continue
            if char == '"':
                state = "normal"
            index += 1
            continue

    return "".join(result)


def _executable_sql() -> str:
    """Return the migration's executable SQL, not explanatory comments."""
    return _strip_sql_comments(_sql())


def test_sql_comment_stripping_preserves_quoted_text():
    sql = """SELECT '-- not a line comment', '/* not a block comment */';
-- actual line comment
/* actual block comment
   with a nested /* inner comment */
*/
SELECT 1;"""
    stripped = _strip_sql_comments(sql)
    assert "'-- not a line comment'" in stripped
    assert "'/* not a block comment */'" in stripped
    assert "actual line comment" not in stripped
    assert "actual block comment" not in stripped
    assert "inner comment" not in stripped
    assert "SELECT 1;" in stripped


def test_legacy_period_timestamp_cast_is_guarded():
    """Only cast a legacy timestamp after PostgreSQL confirms it is parseable."""
    sql = _executable_sql()
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
    sql = _executable_sql()
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
    sql = _executable_sql()
    assert 'm."raw_units" ~ \'^[0-9]\'' in sql
    assert 'm."raw_units" !~ \'[^0-9]\'' in sql
    assert 'NULLIF(ltrim(m."raw_units", \'0\'), \'\')' in sql
    assert 'AS "normalized_units"' in sql
    assert 'm."raw_units"::numeric' not in sql
    assert 'm."raw_units"::bigint' not in sql
    assert 'WHERE n."normalized_units" IS NOT NULL' in sql


def test_safe_integer_cap_precedes_the_bigint_cast():
    """Long values and 16-digit values above JS safe integer are capped."""
    sql = _executable_sql()
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
    sql = _executable_sql()
    assert 'AND n."normalized_units" <> \'0\'' in sql


def test_migration_has_one_complete_transaction():
    """Prevent partial edits and duplicated SQL tails after COMMIT."""
    sql = _executable_sql().strip()
    assert sql.startswith("BEGIN;")
    assert sql.endswith("COMMIT;")
    assert sql.count("BEGIN;") == 1
    assert sql.count("COMMIT;") == 1
    assert "ON CONFLICT (\"workspace_id\", \"meter\", \"period_start\") DO NOTHING;" in sql
