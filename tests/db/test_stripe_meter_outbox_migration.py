"""Guards the legacy watermark timestamp cast in the Stripe meter outbox migration.

The legacy JSON field is user/workspace data. A malformed timestamp must not
abort the entire schema deployment; an unparseable value should simply leave
the new cursor at its zero watermark.
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


def test_invalid_legacy_period_cannot_restore_a_confirmed_watermark():
    """Malformed/missing timestamps must fall through to the zero-unit branch."""
    sql = _sql()
    assert 'parsed."period_start" IS NOT NULL' in sql
    assert '(parsed."period_start" AT TIME ZONE \'UTC\') = p."period_start"' in sql
    assert re.search(
        r'CASE\s+WHEN\s+m\."raw_units"\s+~\s+\'\^\[0-9\]\+\$\'\s+'
        r'AND\s+parsed\."period_start"\s+IS\s+NOT\s+NULL',
        sql,
        flags=re.IGNORECASE,
    )
    assert re.search(
        r'ELSE\s+0\s+END,\s+CURRENT_TIMESTAMP',
        sql,
        flags=re.IGNORECASE,
    )
