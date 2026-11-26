"""The launcher writes .env through a private temporary file and refuses a symlinked .env."""

import os
import stat
import subprocess
from pathlib import Path

import pytest

from tests.test_published_secrets import (
    _values,
)
from tmux_tools.launcher import ALL_GENERATED_KEYS, ensure_env_file

pytestmark = pytest.mark.usefixtures("isolated_generated_secrets")


def test_launcher_refuses_a_symlinked_env_without_writing_through_it(tmp_path):
    example = tmp_path / ".env.example"
    example.write_text("INTERNAL_API_SECRET=\n")
    existing = tmp_path / "other"
    existing.write_text("ENCRYPTION_KEY=\n")
    not_yet = tmp_path / "not-yet"

    for target in (existing, not_yet):  # a link to a file, and a dangling one
        (tmp_path / ".env").unlink(missing_ok=True)
        (tmp_path / ".env").symlink_to(target)
        with pytest.raises(SystemExit) as excinfo:
            ensure_env_file(tmp_path / ".env", example, keys=ALL_GENERATED_KEYS)
        assert "symlink" in str(excinfo.value)

    assert existing.read_text() == "ENCRYPTION_KEY=\n"
    assert not not_yet.exists()


def test_launcher_writes_env_privately_and_leaves_no_temp_file(tmp_path):
    example = tmp_path / ".env.example"
    example.write_text("INTERNAL_API_SECRET=\nCLICKHOUSE_PASSWORD=clickhouse\n")
    env_path = tmp_path / ".env"
    env_path.write_text("INTERNAL_API_SECRET=\nCLICKHOUSE_PASSWORD=clickhouse\n")
    env_path.chmod(0o644)

    ensure_env_file(env_path, example, keys=ALL_GENERATED_KEYS)

    assert stat.S_IMODE(os.stat(env_path).st_mode) == 0o600
    assert len(_values(env_path)["CLICKHOUSE_PASSWORD"]) == 64
    assert [p.name for p in tmp_path.iterdir() if ".tmp." in p.name] == []


def test_launcher_creates_a_new_env_with_mode_600_from_the_start(tmp_path):
    example = tmp_path / ".env.example"
    example.write_text("INTERNAL_API_SECRET=\n")

    ensure_env_file(tmp_path / ".env", example)

    assert stat.S_IMODE(os.stat(tmp_path / ".env").st_mode) == 0o600


def _use_state_dir(monkeypatch, tmp_path):
    from tmux_tools import launcher

    state = tmp_path / ".env.encryption-key.d"
    monkeypatch.setattr(launcher, "STATE_DIR", state)
    monkeypatch.delenv("TRACEROOT_KEY_LOCK_HELD", raising=False)
    return launcher, state


def test_the_launcher_does_not_start_services_while_a_rotation_holds_its_lock(
    tmp_path, monkeypatch
):
    """Services started mid-rotation would read stored credentials with the old key."""
    launcher, state = _use_state_dir(monkeypatch, tmp_path)
    (state / "lock").mkdir(parents=True, mode=0o700)
    state.chmod(0o700)
    commands: list[str] = []
    monkeypatch.setattr(launcher, "_run", lambda command, **kw: commands.append(str(command)))

    with pytest.raises(SystemExit) as excinfo:
        launcher.run_prod_setup()

    assert "rotation is running" in str(excinfo.value)
    assert commands == []


def test_the_launcher_holds_the_lock_for_the_whole_start_and_releases_it(tmp_path, monkeypatch):
    """No rotation can begin between the preflight and the command that starts the apps."""
    launcher, state = _use_state_dir(monkeypatch, tmp_path)
    held_during: list[bool] = []

    def fake_run(command, **kwargs):
        held_during.append((state / "lock").is_dir())

    monkeypatch.setattr(launcher, "_run", fake_run)
    monkeypatch.setattr(launcher, "ensure_env_file", lambda *a, **k: None)

    launcher.run_prod_setup()

    assert held_during and all(held_during)
    assert not (state / "lock").exists()
    assert "TRACEROOT_KEY_LOCK_HELD" not in os.environ


def test_the_launcher_releases_the_lock_when_a_step_fails(tmp_path, monkeypatch):
    launcher, state = _use_state_dir(monkeypatch, tmp_path)

    def failing_run(command, **kwargs):
        raise RuntimeError("compose failed")

    monkeypatch.setattr(launcher, "_run", failing_run)
    monkeypatch.setattr(launcher, "ensure_env_file", lambda *a, **k: None)

    with pytest.raises(RuntimeError):
        launcher.run_prod_setup()

    assert not (state / "lock").exists()


def test_the_launcher_refuses_to_start_while_a_rotation_has_not_finished(tmp_path, monkeypatch):
    launcher, state = _use_state_dir(monkeypatch, tmp_path)
    state.mkdir(mode=0o700)
    (state / "pending").write_text("a" * 64 + "\n")
    commands: list[str] = []
    monkeypatch.setattr(launcher, "_run", lambda command, **kw: commands.append(str(command)))

    with pytest.raises(SystemExit) as excinfo:
        launcher.run_prod_setup()

    assert "did not finish" in str(excinfo.value)
    assert commands == []
    assert not (state / "lock").exists()


def test_the_launcher_leaves_env_alone_while_a_rotation_holds_its_lock(tmp_path, monkeypatch):
    _, state = _use_state_dir(monkeypatch, tmp_path)
    (state / "lock").mkdir(parents=True, mode=0o700)
    state.chmod(0o700)
    example = tmp_path / ".env.example"
    example.write_text("INTERNAL_API_SECRET=\n")

    with pytest.raises(SystemExit):
        ensure_env_file(tmp_path / ".env", example)

    assert not (tmp_path / ".env").exists()


def test_the_launcher_refuses_a_state_directory_others_can_use(tmp_path, monkeypatch):
    launcher, state = _use_state_dir(monkeypatch, tmp_path)
    state.mkdir(mode=0o755)
    state.chmod(0o755)

    with pytest.raises(SystemExit) as excinfo, launcher.key_lock():
        pass

    assert "mode 700" in str(excinfo.value)


def test_the_launcher_and_the_shell_wrapper_exclude_each_other(tmp_path, monkeypatch):
    """One lock, two implementations: each must see the other's."""
    launcher, state = _use_state_dir(monkeypatch, tmp_path)
    wrapper = Path(launcher.ROOT) / "scripts" / "with-key-lock.sh"

    with launcher.key_lock():
        held = subprocess.run(
            ["sh", str(wrapper), "true"],
            cwd=tmp_path,
            capture_output=True,
            text=True,
            env={k: v for k, v in os.environ.items() if k != "TRACEROOT_KEY_LOCK_HELD"},
        )
    assert held.returncode != 0 and "another start or key rotation" in held.stderr

    lock = state / "lock"
    lock.mkdir()
    (lock / "pid").write_text("1\n")
    with pytest.raises(SystemExit), launcher.key_lock():
        pass


def test_the_scratch_copy_used_to_read_env_is_private(monkeypatch):
    """fill_secrets reads a copy of .env through docker compose; that copy is for its owner only."""
    from tmux_tools import launcher

    modes: list[int] = []

    def record(*args, new_value=None):
        modes.append(stat.S_IMODE(os.stat(args[2]).st_mode))
        return "x" if args[0] == "get" else "A=1\n"

    monkeypatch.setattr(launcher, "_env_value", record)

    launcher.fill_secrets("A=\n", ("A",))

    assert modes and set(modes) == {0o600}


def test_the_launcher_refuses_when_compose_reads_other_env_files(tmp_path, monkeypatch):
    launcher, _ = _use_state_dir(monkeypatch, tmp_path)
    monkeypatch.setenv("COMPOSE_ENV_FILES", "other.env")
    example = tmp_path / ".env.example"
    example.write_text("INTERNAL_API_SECRET=\n")

    with pytest.raises(SystemExit) as excinfo:
        launcher.ensure_env_file(tmp_path / ".env", example)

    assert "COMPOSE_ENV_FILES" in str(excinfo.value)
    assert not (tmp_path / ".env").exists()
