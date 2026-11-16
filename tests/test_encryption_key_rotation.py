"""make rotate-encryption-key: the command, its lock, and its failure handling.

The docker call is replaced by a recording stand-in here (the real run against a database
is covered by the end-to-end check); everything else is the real script.
"""

import datetime
import os
import re
import shutil
import stat
import subprocess
import time
from pathlib import Path

import pytest

from tests.test_published_secrets import (
    _ROOT,
    _run_env_secrets,
    _values,
)

_ROTATE = _ROOT / "scripts" / "rotate-encryption-key.sh"


_KEY = "ab" * 32
_OLD_KEY = "9cf7ec27e77884f3d76dda6312f55317b2b6fff317e5b09d4a9ad7b20eff5e00"


_STATE = ".env.encryption-key.d"


def _previous_keys(work: Path) -> list[str]:
    return [p.read_text().strip() for p in sorted((work / _STATE).glob("previous-*"))]


_FAKE_DOCKER = r"""#!/bin/sh
echo "ARGS: $*" >> "$FAKE_DOCKER_LOG"
case "$*" in *" stop "*) [ -n "$FAKE_DOCKER_FAIL_STOP" ] && exit 1;; esac
case "$*" in *"run "*)
    echo "OLD_IS_CURRENT: $([ "$OLD_ENCRYPTION_KEY" = "$FAKE_EXPECT_OLD" ] && echo yes || echo no)" >> "$FAKE_DOCKER_LOG"
    echo "NEW_ENV: $NEW_ENCRYPTION_KEY" >> "$FAKE_PRIVATE_LOG"
    # Stand-in for the database: the one key its rows are encrypted under.
    echo "RUN" >> "$FAKE_RUNS"
    if [ -n "$FAKE_BLOCK_DIR" ]; then
        touch "$FAKE_BLOCK_DIR/started"
        n=0; while [ ! -e "$FAKE_BLOCK_DIR/release" ] && [ $n -lt 200 ]; do sleep 0.1; n=$((n+1)); done
    fi
    if [ -n "$FAKE_SWAP_STATE_DIR" ]; then
        mv .env.encryption-key.d moved-state && mkdir replacement && ln -s replacement .env.encryption-key.d
    fi
    [ -n "$FAKE_DOCKER_FAIL" ] && exit 1
    db_key="$(cat "$FAKE_DB")"
    [ "$db_key" = "$OLD_ENCRYPTION_KEY" ] || [ "$db_key" = "$NEW_ENCRYPTION_KEY" ] || { echo "rows open with neither key" >&2; exit 1; }
    printf '%s' "$NEW_ENCRYPTION_KEY" > "$FAKE_DB"
    # .env cannot be rewritten after the database has committed.
    [ -n "$FAKE_READONLY_ROOT" ] && chmod 555 "$PWD";;
esac
exit 0
"""


@pytest.fixture
def rotation(tmp_path: Path):
    """The real script in a scratch checkout, with `docker` replaced by a recording stand-in."""
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    log = tmp_path / "docker.log"
    fake = bin_dir / "docker"
    fake.write_text(_FAKE_DOCKER)
    fake.chmod(0o755)
    work = tmp_path / "repo"
    work.mkdir()
    db = tmp_path / "db-key"
    db.write_text(_OLD_KEY)
    runs = tmp_path / "runs.log"

    def start(
        fail: bool = False,
        fail_stop: bool = False,
        extra_env: dict[str, str] | None = None,
    ) -> subprocess.Popen:
        env = {
            "PATH": f"{bin_dir}:{os.environ['PATH']}",
            "FAKE_DOCKER_LOG": str(log),
            "FAKE_PRIVATE_LOG": str(tmp_path / "private.log"),
            "FAKE_EXPECT_OLD": _OLD_KEY,
            "FAKE_DB": str(db),
            "FAKE_RUNS": str(runs),
            "ROTATE_ENV_SECRETS": "true",
            **(extra_env or {}),
        }
        if fail:
            env["FAKE_DOCKER_FAIL"] = "1"
        if fail_stop:
            env["FAKE_DOCKER_FAIL_STOP"] = "1"
        return subprocess.Popen(
            ["sh", str(_ROTATE)],
            cwd=work,
            env=env,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )

    def run(**kwargs) -> subprocess.CompletedProcess:
        proc = start(**kwargs)
        out, err = proc.communicate(timeout=60)
        return subprocess.CompletedProcess(proc.args, proc.returncode, out, err)

    run.start = start  # type: ignore[attr-defined]
    run.db = db  # type: ignore[attr-defined]
    run.runs = runs  # type: ignore[attr-defined]
    return work, log, tmp_path / "private.log", run


def test_rotation_writes_a_new_key_and_keeps_the_old_one_aside(rotation):
    work, log, private, run = rotation
    (work / ".env").write_text(f"A=1\nENCRYPTION_KEY={_OLD_KEY}\nB=2\n")

    result = run()

    assert result.returncode == 0, result.stderr
    values = _values(work / ".env")
    assert re.fullmatch(r"[0-9a-f]{64}", values["ENCRYPTION_KEY"])
    assert values["ENCRYPTION_KEY"] != _OLD_KEY
    assert values["A"] == "1" and values["B"] == "2"
    assert _previous_keys(work) == [_OLD_KEY]
    assert not (work / _STATE / "pending").exists()
    assert "OLD_IS_CURRENT: yes" in log.read_text()
    assert f"NEW_ENV: {values['ENCRYPTION_KEY']}" in private.read_text()
    for path in (work / ".env", *(work / _STATE).glob("previous-*")):
        assert not stat.S_IMODE(os.stat(path).st_mode) & (stat.S_IRGRP | stat.S_IROTH)


def test_rotation_never_puts_a_key_on_a_command_line_or_in_its_output(rotation):
    work, log, _, run = rotation
    (work / ".env").write_text(f"ENCRYPTION_KEY={_OLD_KEY}\n")

    result = run()

    new = _values(work / ".env")["ENCRYPTION_KEY"]
    for text in (result.stdout, result.stderr, log.read_text()):
        assert _OLD_KEY not in text and new not in text


def test_a_failed_rotation_leaves_env_alone_and_a_rerun_reuses_the_new_key(rotation):
    work, _, _, run = rotation
    before = f"ENCRYPTION_KEY={_OLD_KEY}\n"
    (work / ".env").write_text(before)

    assert run(fail=True).returncode != 0
    assert (work / ".env").read_text() == before
    pending = (work / _STATE / "pending").read_text().strip()

    assert run().returncode == 0
    assert _values(work / ".env")["ENCRYPTION_KEY"] == pending


def test_rotation_run_twice_is_a_no_op_the_second_time(rotation):
    work, _, _, run = rotation
    (work / ".env").write_text(f"ENCRYPTION_KEY={_OLD_KEY}\n")
    run()
    after_first = (work / ".env").read_text()

    # A pending file left behind by a run that died after writing .env.
    (work / _STATE / "pending").write_text(_values(work / ".env")["ENCRYPTION_KEY"])
    (work / _STATE / "pending").chmod(0o600)
    result = run()

    assert result.returncode == 0
    assert (work / ".env").read_text() == after_first
    assert not (work / _STATE / "pending").exists()


@pytest.mark.parametrize("line", ["", "ENCRYPTION_KEY=\n", "ENCRYPTION_KEY=   # none yet\n"])
def test_rotation_with_no_key_set_says_there_is_nothing_to_rotate(rotation, line):
    work, log, _, run = rotation
    (work / ".env").write_text(line)

    result = run()

    assert result.returncode != 0
    assert "nothing to rotate" in result.stderr
    assert not log.exists()


def test_rotation_refuses_a_symlinked_env(rotation):
    work, log, _, run = rotation
    target = work / "elsewhere"
    target.write_text(f"ENCRYPTION_KEY={_OLD_KEY}\n")
    (work / ".env").symlink_to(target)

    result = run()

    assert result.returncode != 0
    assert "symlink" in result.stderr
    assert target.read_text() == f"ENCRYPTION_KEY={_OLD_KEY}\n"
    assert not log.exists()


def test_rotation_aborts_when_the_services_cannot_be_stopped(rotation):
    """A service still running keeps using the old key, so nothing may change."""
    work, log, _, run = rotation
    before = f"A=1\nENCRYPTION_KEY={_OLD_KEY}\n"
    (work / ".env").write_text(before)

    result = run(fail_stop=True)

    assert result.returncode != 0
    assert "could not stop" in result.stderr
    assert (work / ".env").read_text() == before
    assert "run --rm" not in log.read_text(), "the database must not be touched"
    assert _previous_keys(work) == []


def _plant_state(work: Path, kind: str) -> None:
    state = work / _STATE
    if kind == "dir_is_symlink":
        (work / "elsewhere").mkdir()
        state.symlink_to(work / "elsewhere")
    elif kind == "dir_is_open":
        state.mkdir(mode=0o755)
        state.chmod(0o755)
    elif kind == "pending_is_symlink":
        state.mkdir(mode=0o700)
        (work / "chosen").write_text("d" * 64 + "\n")
        (state / "pending").symlink_to(work / "chosen")
    elif kind == "pending_is_open":
        state.mkdir(mode=0o700)
        (state / "pending").write_text("d" * 64 + "\n")
        (state / "pending").chmod(0o644)


@pytest.mark.parametrize(
    "kind", ["dir_is_symlink", "dir_is_open", "pending_is_symlink", "pending_is_open"]
)
def test_rotation_refuses_a_state_location_others_could_have_prepared(rotation, kind):
    """The new and previous keys are only kept in a directory this user alone controls."""
    work, log, _, run = rotation
    before = f"ENCRYPTION_KEY={_OLD_KEY}\n"
    (work / ".env").write_text(before)
    _plant_state(work, kind)

    result = run()

    assert result.returncode != 0
    assert (work / ".env").read_text() == before
    assert not log.exists(), "nothing may run before the state location is trusted"
    assert "d" * 64 not in (work / ".env").read_text()


def test_a_link_at_the_old_backup_name_is_never_written_through(rotation):
    work, _, _, run = rotation
    (work / ".env").write_text(f"ENCRYPTION_KEY={_OLD_KEY}\n")
    target = work / "unrelated-file"
    target.write_text("")
    (work / ".env.encryption-key.previous").symlink_to(target)

    assert run().returncode == 0
    assert target.read_text() == ""


def test_rotation_rejects_a_pending_file_that_is_not_a_key(rotation):
    work, log, _, run = rotation
    (work / ".env").write_text(f"ENCRYPTION_KEY={_OLD_KEY}\n")
    (work / _STATE).mkdir(mode=0o700)
    pending = work / _STATE / "pending"
    pending.write_text("not-a-key\n")
    pending.chmod(0o600)

    result = run()

    assert result.returncode != 0
    assert "64-character" in result.stderr
    assert not log.exists()


def test_rotation_finds_an_indented_key_and_updates_it_in_place(rotation):
    work, _, _, run = rotation
    (work / ".env").write_text(f"A=1\n  export ENCRYPTION_KEY={_OLD_KEY}\nB=2\n")

    result = run()

    assert result.returncode == 0, result.stderr
    text = (work / ".env").read_text()
    assert text.count("ENCRYPTION_KEY") == 1 and _OLD_KEY not in text
    assert run.db.read_text() == _values(work / ".env")["ENCRYPTION_KEY"]


def test_rotation_stops_when_the_key_in_effect_is_not_in_env(rotation):
    """Compose prefers the process environment, so rewriting .env would change nothing."""
    work, log, _, run = rotation
    before = f"ENCRYPTION_KEY={_OLD_KEY}\n"
    (work / ".env").write_text(before)

    result = run(extra_env={"ENCRYPTION_KEY": "ef" * 32})

    assert result.returncode != 0
    assert "environment" in result.stderr
    assert (work / ".env").read_text() == before
    assert not log.exists(), "the database must not be touched"


def test_rotation_stops_even_when_the_environment_value_matches_env(rotation):
    """Compose would keep using the environment's copy after .env changed, so the services
    could no longer read what was re-encrypted."""
    work, log, _, run = rotation
    before = f"ENCRYPTION_KEY={_OLD_KEY}\n"
    (work / ".env").write_text(before)

    result = run(extra_env={"ENCRYPTION_KEY": _OLD_KEY})

    assert result.returncode != 0
    assert "environment" in result.stderr
    assert (work / ".env").read_text() == before
    assert not log.exists(), "the database must not be touched"
    assert run.db.read_text() == _OLD_KEY


@pytest.mark.parametrize("value", ["${OTHER_KEY}", "short", "zz" * 32, "ab" * 33])
def test_rotation_stops_on_a_key_it_cannot_read_the_way_compose_does(rotation, value):
    work, log, _, run = rotation
    before = f"ENCRYPTION_KEY={value}\n"
    (work / ".env").write_text(before)

    result = run()

    assert result.returncode != 0
    assert "64-character hex" in result.stderr
    assert (work / ".env").read_text() == before
    assert not log.exists()


def test_rotation_stops_when_env_cannot_be_updated(rotation):
    work, log, _, run = rotation
    env_file = work / ".env"
    env_file.write_text(f"ENCRYPTION_KEY={_OLD_KEY}\n")
    env_file.chmod(0o400)

    result = run()

    assert result.returncode != 0
    assert "cannot update .env" in result.stderr
    assert not log.exists()


def test_overlapping_rotations_leave_the_database_and_the_key_in_effect_consistent(
    rotation, tmp_path
):
    work, _, _, run = rotation
    (work / ".env").write_text(f"ENCRYPTION_KEY={_OLD_KEY}\n")
    gate = tmp_path / "gate"
    gate.mkdir()

    first = run.start(extra_env={"FAKE_BLOCK_DIR": str(gate)})
    deadline = time.time() + 30
    while not (gate / "started").exists():
        assert first.poll() is None, first.communicate()
        assert time.time() < deadline, "the first rotation never reached the database step"
        time.sleep(0.05)

    # While the first is migrating the database, a second invocation must be turned away
    # without reading, preparing or changing anything.
    second = run()
    assert second.returncode != 0
    assert "another key rotation is running" in second.stderr
    assert _values(work / ".env")["ENCRYPTION_KEY"] == _OLD_KEY
    assert run.db.read_text() == _OLD_KEY

    (gate / "release").touch()
    _, err = first.communicate(timeout=60)
    assert first.returncode == 0, err

    final = _values(work / ".env")["ENCRYPTION_KEY"]
    assert final != _OLD_KEY
    assert run.db.read_text() == final, "the database and .env must use the same key"
    assert run.runs.read_text().split() == ["RUN"], "only one rotation reached the database"
    assert not (work / _STATE / "lock").exists(), "the lock is released afterwards"
    assert run().returncode == 0, "a later rotation is not blocked by the earlier one"


def test_simultaneous_rotations_admit_exactly_one(rotation):
    work, _, _, run = rotation
    (work / ".env").write_text(f"ENCRYPTION_KEY={_OLD_KEY}\n")

    procs = [run.start() for _ in range(6)]
    results = [(p.communicate(timeout=60), p.returncode) for p in procs]

    codes = [code for _, code in results]
    final = _values(work / ".env")["ENCRYPTION_KEY"]
    assert codes.count(0) >= 1
    # Whoever got in changed the database and .env together; nobody else could.
    assert run.db.read_text() == final
    assert run.runs.read_text().split().count("RUN") == codes.count(0)
    for (_, err), code in results:
        if code != 0:
            assert "another key rotation is running" in err or "nothing left" in err, err


def _plant_lock(work: Path, pid: str) -> Path:
    lock = work / _STATE / "lock"
    lock.mkdir(parents=True, mode=0o700)
    (work / _STATE).chmod(0o700)
    (lock / "pid").write_text(f"{pid}\n")
    return lock


def test_a_lock_left_by_a_process_that_is_gone_is_not_cleared_automatically(rotation):
    """Two runs could both judge the same lock stale and both take it; an operator removes it."""
    work, log, _, run = rotation
    (work / ".env").write_text(f"ENCRYPTION_KEY={_OLD_KEY}\n")
    lock = _plant_lock(work, "999999")

    result = run()

    assert result.returncode != 0
    assert "another key rotation is running" in result.stderr
    assert "remove" in result.stderr and ".env.encryption-key.d/lock" in result.stderr
    assert lock.exists() and not log.exists()

    shutil.rmtree(lock)
    assert run().returncode == 0, "removing the lock lets rotation run"


def test_simultaneous_rotations_that_all_see_a_stale_lock_all_stay_out(rotation):
    work, _, _, run = rotation
    (work / ".env").write_text(f"ENCRYPTION_KEY={_OLD_KEY}\n")
    _plant_lock(work, "999999")

    procs = [run.start() for _ in range(6)]
    codes = [(p.communicate(timeout=60), p.returncode)[1] for p in procs]

    assert all(code != 0 for code in codes)
    assert not run.runs.exists(), "no rotation may reach the database"
    assert run.db.read_text() == _OLD_KEY
    assert _values(work / ".env")["ENCRYPTION_KEY"] == _OLD_KEY


def test_a_lock_held_by_a_running_process_blocks_rotation(rotation):
    work, log, _, run = rotation
    (work / ".env").write_text(f"ENCRYPTION_KEY={_OLD_KEY}\n")
    lock = work / _STATE / "lock"
    lock.mkdir(parents=True, mode=0o700)
    (work / _STATE).chmod(0o700)
    (lock / "pid").write_text(f"{os.getpid()}\n")

    result = run()

    assert result.returncode != 0 and "another key rotation is running" in result.stderr
    assert not log.exists()


def test_env_secrets_waits_for_a_running_rotation(tmp_path):
    """Both rewrite .env; an interleaved write could put the old key back."""
    (tmp_path / ".env.example").write_text("ENCRYPTION_KEY=\n")
    (tmp_path / ".env").write_text(f"ENCRYPTION_KEY={_KEY}\n")
    (tmp_path / _STATE / "lock").mkdir(parents=True)

    result = _run_env_secrets(tmp_path, check=False)

    assert result.returncode != 0
    assert b"rotation is running" in result.stderr


def test_replacing_the_state_directory_mid_run_does_not_redirect_the_saved_key(rotation):
    work, _, _, run = rotation
    (work / ".env").write_text(f"ENCRYPTION_KEY={_OLD_KEY}\n")

    result = run(extra_env={"FAKE_SWAP_STATE_DIR": "1"})

    assert result.returncode == 0, result.stderr
    replacement = work / "replacement"
    assert list(replacement.iterdir()) == [], "nothing may be written to the replacement"
    kept = list((work / "moved-state").glob("previous-*"))
    assert [p.read_text().strip() for p in kept] == [_OLD_KEY]


def test_an_existing_backup_name_is_never_followed_or_overwritten(rotation):
    """Even inside the private directory, an existing name is never followed or overwritten."""
    work, _, _, run = rotation
    (work / ".env").write_text(f"ENCRYPTION_KEY={_OLD_KEY}\n")
    state = work / _STATE
    state.mkdir(mode=0o700)
    target = work / "elsewhere"
    target.write_text("")
    # Whatever second the script picks, a link already under that name is not followed.
    now = datetime.datetime.now()
    for offset in range(-2, 40):
        stamp = (now + datetime.timedelta(seconds=offset)).strftime("%Y%m%d%H%M%S")
        link = state / f"previous-{stamp}"
        if not link.exists() and not link.is_symlink():
            link.symlink_to(target)

    assert run().returncode == 0
    assert target.read_text() == ""


def test_rotation_treats_the_example_key_in_upper_case_as_the_current_key(rotation):
    work, _, _, run = rotation
    upper = _OLD_KEY.upper()
    (work / ".env").write_text(f"ENCRYPTION_KEY={upper}\n")
    run.db.write_text(upper)

    assert run().returncode == 0
    assert _values(work / ".env")["ENCRYPTION_KEY"] != upper


def test_rotation_stops_when_compose_may_read_the_key_from_another_file(rotation, tmp_path):
    """COMPOSE_ENV_FILES replaces .env, so updating .env would not change what services use."""
    work, log, _, run = rotation
    before = f"ENCRYPTION_KEY={_OLD_KEY}\n"
    (work / ".env").write_text(before)
    alternate = tmp_path / "other.env"
    alternate.write_text(f"ENCRYPTION_KEY={_OLD_KEY}\n")

    result = run(extra_env={"COMPOSE_ENV_FILES": str(alternate)})

    assert result.returncode != 0
    assert "COMPOSE_ENV_FILES" in result.stderr
    assert (work / ".env").read_text() == before
    assert not log.exists()
    assert run.db.read_text() == _OLD_KEY


@pytest.mark.parametrize(
    "line",
    [
        f"ENCRYPTION_KEY: {_OLD_KEY}",
        f"  ENCRYPTION_KEY : {_OLD_KEY}",
        f"export ENCRYPTION_KEY:{_OLD_KEY}",
    ],
)
def test_rotation_finds_a_colon_assignment_and_leaves_one_line(rotation, line):
    work, _, _, run = rotation
    (work / ".env").write_text(f"A=1\n{line}\nB=2\n")

    result = run()

    assert result.returncode == 0, result.stderr
    text = (work / ".env").read_text()
    assert text.count("ENCRYPTION_KEY") == 1 and _OLD_KEY not in text
    assert run.db.read_text() == _values(work / ".env")["ENCRYPTION_KEY"]


def test_when_env_cannot_be_written_after_the_database_changed_the_new_key_is_kept(rotation):
    """The database commit comes first, so say so, keep the new key, and let a rerun finish."""
    work, _, _, run = rotation
    before = f"ENCRYPTION_KEY={_OLD_KEY}\n"
    (work / ".env").write_text(before)

    try:
        result = run(extra_env={"FAKE_READONLY_ROOT": "1"})
        new_key = run.db.read_text()
        assert result.returncode != 0
        assert new_key != _OLD_KEY, "the database already uses the new key"
        assert (work / ".env").read_text() == before, ".env still has the old key"
        assert "database already uses the new key" in result.stderr
        assert (work / _STATE / "pending").read_text().strip() == new_key
        assert not (work / _STATE / "lock").exists(), "the lock is released"
    finally:
        work.chmod(0o755)

    rerun = run()

    assert rerun.returncode == 0, rerun.stderr
    assert _values(work / ".env")["ENCRYPTION_KEY"] == new_key
    assert run.db.read_text() == new_key
    assert not (work / _STATE / "pending").exists()
