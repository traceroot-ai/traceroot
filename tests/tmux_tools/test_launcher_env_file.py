"""The launcher writes .env through a private temporary file and refuses a symlinked .env."""

import os
import stat

import pytest

from tests.test_published_secrets import (
    _values,
)
from tmux_tools.launcher import ALL_GENERATED_KEYS, ensure_env_file


def test_launcher_refuses_a_symlinked_env(tmp_path):
    example = tmp_path / ".env.example"
    example.write_text("INTERNAL_API_SECRET=\n")
    target = tmp_path / "other"
    target.write_text("ENCRYPTION_KEY=\n")
    (tmp_path / ".env").symlink_to(target)

    with pytest.raises(SystemExit) as excinfo:
        ensure_env_file(tmp_path / ".env", example, keys=ALL_GENERATED_KEYS)

    assert "symlink" in str(excinfo.value)
    assert target.read_text() == "ENCRYPTION_KEY=\n"


def test_launcher_refuses_a_dangling_env_symlink_instead_of_creating_through_it(tmp_path):
    example = tmp_path / ".env.example"
    example.write_text("INTERNAL_API_SECRET=\n")
    target = tmp_path / "not-yet"
    (tmp_path / ".env").symlink_to(target)

    with pytest.raises(SystemExit):
        ensure_env_file(tmp_path / ".env", example)

    assert not target.exists()


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


def test_the_launcher_does_not_start_services_while_a_rotation_holds_its_lock(
    tmp_path, monkeypatch
):
    """Services started mid-rotation would read stored credentials with the old key."""
    from tmux_tools import launcher

    lock = tmp_path / ".env.encryption-key.d" / "lock"
    lock.mkdir(parents=True)
    monkeypatch.setattr(launcher, "ROTATION_LOCK", lock)
    commands: list[str] = []
    monkeypatch.setattr(launcher, "_run", lambda command, **kw: commands.append(str(command)))
    monkeypatch.setattr(launcher, "ensure_env_file", lambda *a, **k: None)

    with pytest.raises(SystemExit) as excinfo:
        launcher.run_prod_setup()

    assert "rotation is running" in str(excinfo.value)
    assert not any(" up " in command for command in commands)


def test_the_launcher_stops_before_starting_apps_when_a_rotation_begins_meanwhile(
    tmp_path, monkeypatch
):
    from tmux_tools import launcher

    lock = tmp_path / ".env.encryption-key.d" / "lock"
    monkeypatch.setattr(launcher, "ROTATION_LOCK", lock)
    commands: list[str] = []

    def fake_run(command, **kwargs):
        commands.append(str(command))
        if " build" in str(command):
            lock.mkdir(parents=True)  # a rotation starts while images are being built

    monkeypatch.setattr(launcher, "_run", fake_run)
    monkeypatch.setattr(launcher, "ensure_env_file", lambda *a, **k: None)

    with pytest.raises(SystemExit):
        launcher.run_prod_setup()

    assert not any("up -d web" in command for command in commands)


def test_the_launcher_leaves_env_alone_while_a_rotation_holds_its_lock(tmp_path, monkeypatch):
    from tmux_tools import launcher

    lock = tmp_path / ".env.encryption-key.d" / "lock"
    lock.mkdir(parents=True)
    monkeypatch.setattr(launcher, "ROTATION_LOCK", lock)
    example = tmp_path / ".env.example"
    example.write_text("INTERNAL_API_SECRET=\n")

    with pytest.raises(SystemExit):
        ensure_env_file(tmp_path / ".env", example)

    assert not (tmp_path / ".env").exists()
