from pathlib import Path
from subprocess import CompletedProcess

import pytest

from db.clickhouse import migrate


def test_goose_command_uses_env_overrides():
    command = migrate.goose_command(
        "up",
        env={
            "CLICKHOUSE_HOST": "clickhouse.internal",
            "CLICKHOUSE_PORT": "9440",
            "CLICKHOUSE_USER": "trace",
            "CLICKHOUSE_PASSWORD": "secret",
            "CLICKHOUSE_DATABASE": "events",
        },
    )

    assert command[:4] == ["goose", "-dir", str(migrate.migrations_dir()), "clickhouse"]
    assert (
        command[4]
        == "tcp://clickhouse.internal:9440?username=trace&password=secret&database=events"
    )
    assert command[5] == "up"


def test_goose_dbstring_percent_encodes_credentials():
    # A password with URL-reserved characters must not corrupt the DSN query
    # string: '&' and '=' would otherwise split the password or start a new
    # parameter, so goose would connect with truncated/wrong credentials.
    dbstring = migrate.goose_dbstring(
        env={
            "CLICKHOUSE_HOST": "clickhouse.internal",
            "CLICKHOUSE_PORT": "9000",
            "CLICKHOUSE_USER": "trace user",
            "CLICKHOUSE_PASSWORD": "p@ss:w/rd&x=1?#+",
            "CLICKHOUSE_DATABASE": "events/prod",
        }
    )

    assert dbstring == (
        "tcp://clickhouse.internal:9000"
        "?username=trace%20user"
        "&password=p%40ss%3Aw%2Frd%26x%3D1%3F%23%2B"
        "&database=events%2Fprod"
    )


def test_goose_dbstring_leaves_plain_credentials_unchanged():
    # Values without reserved characters must round-trip verbatim so existing
    # deployments see an identical DSN.
    dbstring = migrate.goose_dbstring(
        env={
            "CLICKHOUSE_HOST": "localhost",
            "CLICKHOUSE_PORT": "9000",
            "CLICKHOUSE_USER": "clickhouse",
            "CLICKHOUSE_PASSWORD": "clickhouse",
            "CLICKHOUSE_DATABASE": "default",
        }
    )

    assert dbstring == (
        "tcp://localhost:9000?username=clickhouse&password=clickhouse&database=default"
    )


def test_goose_command_create_requires_name():
    with pytest.raises(ValueError, match="required"):
        migrate.goose_command("create")


def test_goose_command_rejects_name_for_non_create():
    with pytest.raises(ValueError, match="not supported"):
        migrate.goose_command("status", name="ignored")


def test_resolve_pressly_goose_prefers_valid_binary(monkeypatch, tmp_path):
    valid = tmp_path / "goose"
    valid.write_text("stub", encoding="utf-8")

    monkeypatch.setattr(
        migrate,
        "_goose_candidates",
        lambda env=None: [Path("/not-real/goose"), valid],
    )
    monkeypatch.setattr(
        migrate,
        "_run_command",
        lambda command, **kwargs: CompletedProcess(
            command,
            0,
            stdout="Usage: goose DRIVER DBSTRING [OPTIONS] COMMAND\n-dir string\nGOOSE_DRIVER",
            stderr="",
        ),
    )

    assert migrate.resolve_pressly_goose() == str(valid)


def test_is_pressly_goose_returns_false_for_non_executable_candidate(monkeypatch, tmp_path):
    invalid = tmp_path / "goose"
    invalid.write_text("stub", encoding="utf-8")

    def raise_permission_error(command, **kwargs):
        raise PermissionError(f"cannot execute {command[0]}")

    monkeypatch.setattr(migrate, "_run_command", raise_permission_error)

    assert migrate.is_pressly_goose(invalid) is False


def test_docker_goose_command_supports_up():
    assert migrate.docker_goose_command("up") == [
        "docker",
        "compose",
        "run",
        "--rm",
        "--no-deps",
        "migrate-clickhouse",
        "up",
    ]


def test_docker_goose_command_rejects_create():
    with pytest.raises(ValueError, match="Docker fallback"):
        migrate.docker_goose_command("create")
