"""Static safety contracts for migration 017's table rebuild and rollback."""

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


def test_upgrade_requires_writer_pause_and_never_drops_rollback_backstop():
    up, _ = _sections()

    assert "Pause all writers" in up
    assert "DROP TABLE IF EXISTS traces_old" not in up
    assert "RENAME TABLE traces TO traces_old, traces_v2 TO traces" in up


def test_legacy_backfill_preserves_ambiguous_kind_but_protects_established_identity():
    up, _ = _sections()

    assert "s.span_start_time = old_traces.trace_start_time" in up
    assert "s.name = old_traces.name" in up
    assert "'placeholder'" in up
    assert "bitShiftLeft(toUInt64(4), 61)" in up
    assert "toUInt64(0)" in up


def test_rollback_merges_new_rows_before_restoring_old_schema():
    _, down = _sections()

    merge = down.index("INSERT INTO traces_old")
    drop = down.index("DROP TABLE traces")
    rename = down.index("RENAME TABLE traces_old TO traces")
    assert merge < drop < rename
    assert "FROM traces;" in down[merge:drop]
