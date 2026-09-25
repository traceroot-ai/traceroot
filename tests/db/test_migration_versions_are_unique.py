"""Guards that no two ClickHouse migrations claim the same goose version.

goose identifies a migration by the numeric prefix of its filename, so two
files sharing a prefix are a fatal collision: `goose: duplicate version 9
detected` is raised inside `Migrations.Less` while migrations are collected
off disk, before the database is ever dialed. Every migration then fails,
not just the colliding pair, and anything gated on the migrate container
(`service_completed_successfully`, the helm pre-upgrade hook) stalls with it.

Git will not catch this: two branches adding `009_a.sql` and `009_b.sql`
merge cleanly because the filenames differ. Versions are parsed here the way
goose parses them rather than listed literally, so a migration added later is
covered without touching this file.
"""

import re
from collections import defaultdict
from collections.abc import Iterable
from pathlib import Path

MIGRATIONS_DIR = (
    Path(__file__).resolve().parents[2] / "backend" / "db" / "clickhouse" / "migrations"
)

VERSION_PREFIX = re.compile(r"^(\d+)_")


def _goose_version(filename: str) -> int | None:
    """Parse the goose version out of a migration filename.

    Mirrors goose's own rule: the digits before the first underscore, read
    as an integer that must be greater than zero. Reading it as an integer
    (not as text) is what makes `009_x.sql` and `9_y.sql` the same version,
    exactly as goose sees them.

    Args:
        filename (str): Bare migration filename, e.g. `009_add_metadata_map.sql`.

    Returns:
        int | None: The version, or None if goose could not parse one.
    """
    match = VERSION_PREFIX.match(filename)
    if match is None:
        return None
    version = int(match.group(1))
    return version if version > 0 else None


def _duplicate_versions(filenames: Iterable[str]) -> dict[int, list[str]]:
    """Find versions claimed by more than one migration filename.

    Args:
        filenames (Iterable[str]): Bare migration filenames.

    Returns:
        dict[int, list[str]]: Colliding version to the filenames claiming it,
            both ordered so the failure message is stable.
    """
    by_version: dict[int, list[str]] = defaultdict(list)
    for name in filenames:
        version = _goose_version(name)
        if version is not None:
            by_version[version].append(name)
    return {
        version: sorted(names) for version, names in sorted(by_version.items()) if len(names) > 1
    }


def test_goose_version_reads_the_numeric_prefix():
    """Zero padding is insignificant and an unparseable name yields no version."""
    assert _goose_version("009_add_metadata_map.sql") == 9
    assert _goose_version("9_add_metadata_map.sql") == 9
    assert _goose_version("010_materialize_metadata_map.sql") == 10
    assert _goose_version("add_metadata_map.sql") is None
    assert _goose_version("000_zeroth.sql") is None


def test_duplicate_versions_reports_every_colliding_filename():
    """Distinct filenames sharing one version are grouped under that version."""
    duplicates = _duplicate_versions(
        [
            "008_add_source_to_spans_projection.sql",
            "009_add_metadata_map.sql",
            "009_partition_detector_tables_by_month.sql",
            "9_partition_detector_tables_by_month.sql",
            "010_materialize_metadata_map.sql",
        ]
    )
    assert duplicates == {
        9: [
            "009_add_metadata_map.sql",
            "009_partition_detector_tables_by_month.sql",
            "9_partition_detector_tables_by_month.sql",
        ]
    }


def test_duplicate_versions_accepts_gaps_and_unordered_input():
    """Gaps and out-of-order files are legitimate; only collisions are reported."""
    assert _duplicate_versions(["005_e.sql", "001_a.sql", "042_f.sql"]) == {}


def test_every_migration_filename_carries_a_goose_version():
    """No migration escapes the uniqueness check by being unparseable.

    goose refuses to collect a file it cannot version, so a misnamed
    migration is broken on its own account, and it would also slip past
    the duplicate check below unnoticed.
    """
    migration_files = sorted(MIGRATIONS_DIR.glob("*.sql"))
    assert migration_files, f"no migrations found in {MIGRATIONS_DIR}"

    unversioned = [path.name for path in migration_files if _goose_version(path.name) is None]
    assert not unversioned, (
        "every migration filename must start with a positive version number followed by "
        f"'_', as goose parses it; these do not: {unversioned}"
    )


def test_migration_versions_are_unique():
    """Every migration on disk claims a version no other migration claims."""
    migration_files = sorted(MIGRATIONS_DIR.glob("*.sql"))
    assert migration_files, f"no migrations found in {MIGRATIONS_DIR}"

    duplicates = _duplicate_versions(path.name for path in migration_files)
    collisions = "; ".join(
        f"version {version} is claimed by {' and '.join(names)}"
        for version, names in duplicates.items()
    )
    assert not duplicates, (
        f"duplicate migration versions in {MIGRATIONS_DIR}: {collisions}. "
        "goose panics with 'duplicate version N detected' and every migration fails, "
        "not just these. Renumber the newer file to the next unused version."
    )
