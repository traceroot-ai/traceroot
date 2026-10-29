"""Guards that no two migrations claim the same version, for both migration tools.

ClickHouse (goose): goose identifies a migration by the numeric prefix of its filename, so two
files sharing a prefix are a fatal collision: `goose: duplicate version 9
detected` is raised inside `Migrations.Less` while migrations are collected
off disk, before the database is ever dialed. Every migration then fails,
not just the colliding pair, and anything gated on the migrate container
(`service_completed_successfully`, the helm pre-upgrade hook) stalls with it.

Git will not catch this: two branches adding `009_a.sql` and `009_b.sql`
merge cleanly because the filenames differ. Versions are parsed here the way
goose parses them rather than listed literally, so a migration added later is
covered without touching this file.

Postgres (Prisma): a migration folder is `<YYYYMMDDHHMMSS>_<name>`, and two
folders sharing a timestamp are guarded the same way; see the Prisma section
below for why that collision matters even though it is not fatal.
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


# --- Prisma (Postgres) migrations --------------------------------------------
#
# Prisma names a migration by its folder, `<YYYYMMDDHHMMSS>_<name>`, and applies
# pending folders in lexicographic order of the full folder name. Two folders
# sharing a timestamp are therefore not fatal the way a goose collision is: the
# order between them is decided by the alphabetical order of their names rather
# than by when they were written, which is an accident nobody chose. It also
# reads as a mistake to every reviewer, and git merges it silently for the same
# reason as above: the folder names differ. Parsed rather than listed, so a
# migration added later is covered without touching this file.

PRISMA_MIGRATIONS_DIR = (
    Path(__file__).resolve().parents[2] / "frontend" / "packages" / "core" / "prisma" / "migrations"
)

PRISMA_TIMESTAMP_PREFIX = re.compile(r"^(\d{14})_.+")


def _prisma_timestamp(dirname: str) -> str | None:
    """Parse the timestamp out of a Prisma migration folder name.

    Kept as text, not an integer: the prefix is a fixed-width
    `YYYYMMDDHHMMSS` stamp and Prisma orders folders as strings, so two
    folders collide only when those fourteen characters are identical.

    Args:
        dirname (str): Bare migration folder name, e.g.
            `20260902000000_write_name_constraints`.

    Returns:
        str | None: The 14-digit timestamp, or None if the name does not
            carry one followed by `_` and a migration name.
    """
    match = PRISMA_TIMESTAMP_PREFIX.match(dirname)
    return match.group(1) if match else None


def _duplicate_prisma_timestamps(dirnames: Iterable[str]) -> dict[str, list[str]]:
    """Find timestamps claimed by more than one Prisma migration folder.

    Args:
        dirnames (Iterable[str]): Bare migration folder names.

    Returns:
        dict[str, list[str]]: Colliding timestamp to the folders claiming it,
            both ordered so the failure message is stable.
    """
    by_timestamp: dict[str, list[str]] = defaultdict(list)
    for name in dirnames:
        timestamp = _prisma_timestamp(name)
        if timestamp is not None:
            by_timestamp[timestamp].append(name)
    return {
        timestamp: sorted(names)
        for timestamp, names in sorted(by_timestamp.items())
        if len(names) > 1
    }


def _prisma_migration_dirs() -> list[Path]:
    """List the Prisma migration folders on disk (`migration_lock.toml` is a file)."""
    return sorted(path for path in PRISMA_MIGRATIONS_DIR.iterdir() if path.is_dir())


def test_prisma_timestamp_reads_the_fourteen_digit_prefix():
    """Only a full `YYYYMMDDHHMMSS_` prefix followed by a name is a timestamp."""
    assert _prisma_timestamp("20260902000000_write_name_constraints") == "20260902000000"
    assert _prisma_timestamp("20260814000001_offline_eval") == "20260814000001"
    assert _prisma_timestamp("2026090200000_short_stamp") is None
    assert _prisma_timestamp("20260902000000_") is None
    assert _prisma_timestamp("write_name_constraints") is None


def test_duplicate_prisma_timestamps_reports_every_colliding_folder():
    """The collision that motivated this guard is reported, and adjacent stamps are not."""
    duplicates = _duplicate_prisma_timestamps(
        [
            "20260814000001_offline_eval",
            "20260818000000_test_case_unique_version_case_id",
            "20260818000000_eval_run_coverage",
            "20260818000001_later_the_same_day",
        ]
    )
    assert duplicates == {
        "20260818000000": [
            "20260818000000_eval_run_coverage",
            "20260818000000_test_case_unique_version_case_id",
        ]
    }


def test_duplicate_prisma_timestamps_accepts_gaps_and_unordered_input():
    """Gaps and out-of-order folders are legitimate; only collisions are reported."""
    assert (
        _duplicate_prisma_timestamps(
            ["20260902000000_c", "20250101000000_a", "20260827000000_b"],
        )
        == {}
    )


def test_every_prisma_migration_folder_carries_a_timestamp():
    """No migration folder escapes the uniqueness check by being unparseable."""
    migration_dirs = _prisma_migration_dirs()
    assert migration_dirs, f"no migrations found in {PRISMA_MIGRATIONS_DIR}"

    unstamped = [path.name for path in migration_dirs if _prisma_timestamp(path.name) is None]
    assert not unstamped, (
        "every Prisma migration folder must be named <YYYYMMDDHHMMSS>_<name>, "
        f"as `prisma migrate dev` creates it; these are not: {unstamped}"
    )


def test_prisma_migration_timestamps_are_unique():
    """Every Prisma migration folder claims a timestamp no other folder claims."""
    migration_dirs = _prisma_migration_dirs()
    assert migration_dirs, f"no migrations found in {PRISMA_MIGRATIONS_DIR}"

    duplicates = _duplicate_prisma_timestamps(path.name for path in migration_dirs)
    collisions = "; ".join(
        f"timestamp {timestamp} is claimed by {' and '.join(names)}"
        for timestamp, names in duplicates.items()
    )
    assert not duplicates, (
        f"duplicate Prisma migration timestamps in {PRISMA_MIGRATIONS_DIR}: {collisions}. "
        "Prisma would order them by name rather than by when they were written. "
        "Rename the newer folder to a timestamp after the latest migration on main."
    )
