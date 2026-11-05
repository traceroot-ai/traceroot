"""Static safety contracts for migration 017's table rebuild and rollback.

The checks are SQL-aware rather than substring-exact: statements are split on
their terminators, SQL comments stripped, and whitespace collapsed, so a
reformatted but semantically identical migration still passes while a real
regression (a ``DROP TABLE traces_old`` in any casing, a correlated subquery,
a ``<<`` operator) fails in whichever shape it is written.
"""

import re
from pathlib import Path

MIGRATION = (
    Path(__file__).resolve().parents[2]
    / "backend"
    / "db"
    / "clickhouse"
    / "migrations"
    / "017_rebuild_traces_with_root_precedence.sql"
)


def _sections() -> tuple[str, str]:
    text = MIGRATION.read_text()
    up, down = text.split("-- +goose Down", 1)
    return up, down


def _normalized(sql: str) -> str:
    """Comment-free, whitespace-collapsed, casefolded SQL for tolerant matching."""

    no_comments = "\n".join(line.split("--", 1)[0] for line in sql.splitlines())
    return re.sub(r"\s+", " ", no_comments).strip().lower()


def _statements(sql: str) -> list[str]:
    return [s.strip() for s in _normalized(sql).split(";") if s.strip()]


def _backfill_statement(up: str) -> str:
    """The ``INSERT INTO traces_v2 ... SELECT`` statement that rebuilds identity."""

    matches = [s for s in _statements(up) if s.startswith("insert into traces_v2")]
    assert matches, "migration must contain an INSERT INTO traces_v2 backfill"
    return matches[0]


# -- Up: the table swap -------------------------------------------------------


def test_upgrade_requires_writer_pause_and_never_drops_rollback_backstop():
    up, _ = _sections()
    norm_up = _normalized(up)

    # The pause requirement is documented in the header (raw text, comments
    # included) and enforced by the compose ordering the comment names.
    assert "pause" in up.lower()
    assert "service_completed_successfully" in up
    # A retry must never delete the rollback backstop: no statement may DROP
    # traces_old in any casing or spelling, and the only statement touching it
    # is the rename itself.
    assert not re.search(r"drop\s+table\s+(if\s+exists\s+)?traces_old\b", norm_up), (
        "Up must never drop traces_old — it is the rollback backstop"
    )
    touching = [s for s in _statements(up) if "traces_old" in s]
    assert touching and all(s.startswith("rename table") for s in touching)
    assert "rename table traces to traces_old, traces_v2 to traces" in norm_up


def test_upgrade_retry_safety_rebuilds_traces_v2_from_scratch():
    """The first statement drops any partial traces_v2, so a failure at or
    before the backfill (the step that fails first in practice) re-runs cleanly
    against the untouched `traces`."""

    up, _ = _sections()
    statements = _statements(up)
    assert statements[0].startswith("drop table if exists traces_v2")
    assert statements[1].startswith("create table traces_v2")


def test_projection_materializes_before_the_table_swap():
    up, _ = _sections()
    statements = _statements(up)
    materialize = next(i for i, s in enumerate(statements) if "materialize projection" in s)
    rename = next(i for i, s in enumerate(statements) if s.startswith("rename table"))
    assert materialize < rename


# -- Up: the legacy backfill expression ----------------------------------------


def test_backfill_is_clickhouse_25_2_compatible():
    """The repository's default ClickHouse (25.2) rejects both constructs the
    first version of this migration used: the `<<` operator (CI-confirmed
    `code: 62 SYNTAX_ERROR`) and correlated subqueries (`EXISTS` referencing the
    outer row). The backfill must parse on 25.2 — asserted here as the absence
    of both constructs in any statement, and verified live against a 25.2
    server by the Agent Trace Contract workflow."""

    up, _ = _sections()
    # Comments may discuss the operator in prose; the SQL itself must not.
    assert "<<" not in _normalized(up), "bit shifts must use bitShiftLeft, not the << operator"
    backfill = _backfill_statement(up)
    assert "exists" not in backfill, "the backfill must not use correlated EXISTS"


def test_backfill_matches_parentless_spans_within_the_same_project_and_trace_only():
    """The legacy classification may never match a span of another project or
    trace: the tuple membership is element-wise and carries project_id and
    trace_id alongside the identity columns it compares."""

    backfill = _backfill_statement(_sections()[0])

    assert "(project_id, trace_id, trace_start_time, name) in (" in backfill
    assert "from spans where isnull(parent_span_id)" in backfill


def test_backfill_preserves_ambiguous_kind_but_protects_established_identity():
    """Legacy rows keep root_kind='placeholder' and get only the INTERMEDIATE
    rank (4 << 61): never the true-root rank (6 << 61), never remote_parent —
    a newly classified true root must still be able to replace them."""

    backfill = _backfill_statement(_sections()[0])

    assert "'placeholder'" in backfill
    assert "bitshiftleft(touint64(4), 61)" in backfill
    assert "bitshiftleft(touint64(6), 61)" not in backfill
    assert "'root'" not in backfill
    # Inverted-millisecond constant (1 << 60) - 1 from shared/trace_identity.py.
    assert "1152921504606846975" in backfill
    # Unmatchable rows stay at the placeholder version 0.
    assert "touint64(0)" in backfill


def test_backfill_deduplicates_to_one_canonical_row_per_logical_trace():
    """The old table's sort key included toDate(trace_start_time), so versions
    of one trace across date buckets (and unmerged replays) are separate
    physical rows. The new table collapses them and would keep an ARBITRARY one
    on an equal-version merge, so the backfill must select the canonical row —
    the one the old public view answered from — deterministically."""

    backfill = _backfill_statement(_sections()[0])

    assert "order by ch_update_time desc, trace_start_time desc" in backfill
    assert "limit 1 by project_id, trace_id" in backfill


# -- Down: the rollback ---------------------------------------------------------


def test_rollback_merges_new_rows_before_restoring_old_schema():
    """Rollback must not discard rows written to the new table after the swap:
    they are merged into traces_old before the new table is dropped, then the
    old schema takes the `traces` name back. The public view is recreated from
    the restored table."""

    _, down = _sections()
    statements = _statements(down)

    merge = next(i for i, s in enumerate(statements) if s.startswith("insert into traces_old"))
    drop = next(i for i, s in enumerate(statements) if s.startswith("drop table traces"))
    rename = next(
        i for i, s in enumerate(statements) if s.startswith("rename table traces_old to traces")
    )
    assert merge < drop < rename
    assert "from traces" in statements[merge]
    # No statement of the rollback may drop the backstop it just merged into.
    assert not re.search(r"drop\s+table\s+(if\s+exists\s+)?traces_old\b", _normalized(down))
