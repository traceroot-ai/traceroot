"""The encryption key in effect: startup and rotation read .env the way Docker Compose does.

A normal start must keep a key Compose already accepts, in whatever form it is written,
and never add a second assignment that would shadow it.
"""

import os
import re
import subprocess
from pathlib import Path

import pytest

from tests.test_published_secrets import (
    _ROOT,
    _run_env_secrets,
    _values,
)
from tmux_tools.launcher import ensure_env_file, fill_secrets


def test_prod_lite_generates_an_encryption_key_when_none_is_set(tmp_path):
    (tmp_path / ".env.example").write_text("ENCRYPTION_KEY=\n")
    _run_env_secrets(tmp_path)
    key = _values(tmp_path / ".env")["ENCRYPTION_KEY"]
    assert re.fullmatch(r"[0-9a-f]{64}", key), key


@pytest.mark.parametrize(
    "value",
    ["9cf7ec27e77884f3d76dda6312f55317b2b6fff317e5b09d4a9ad7b20eff5e00", "a" * 64, "changeme"],
)
def test_prod_lite_never_replaces_an_encryption_key_that_is_set(tmp_path, value):
    """Stored provider keys are encrypted under it; replacing it would orphan them."""
    (tmp_path / ".env.example").write_text("ENCRYPTION_KEY=\n")
    (tmp_path / ".env").write_text(f"ENCRYPTION_KEY={value}\n")
    _run_env_secrets(tmp_path)
    assert _values(tmp_path / ".env")["ENCRYPTION_KEY"] == value


def test_launcher_fills_an_empty_encryption_key_but_keeps_a_set_one():
    assert re.search(r"ENCRYPTION_KEY=[0-9a-f]{64}", fill_secrets("ENCRYPTION_KEY=\n"))
    for value in ("9cf7ec27e77884f3d76dda6312f55317b2b6fff317e5b09d4a9ad7b20eff5e00", "changeme"):
        text = f"ENCRYPTION_KEY={value}\n"
        assert fill_secrets(text, ("ENCRYPTION_KEY",)) == text


def test_the_dev_path_fills_the_encryption_key(tmp_path):
    env_path, example = tmp_path / ".env", tmp_path / ".env.example"
    example.write_text("INTERNAL_API_SECRET=\nBETTER_AUTH_SECRET=\n")
    ensure_env_file(env_path, example)
    assert re.fullmatch(r"[0-9a-f]{64}", _values(env_path)["ENCRYPTION_KEY"])


_ENV_VALUE = _ROOT / "scripts" / "env-value.sh"


_KEY = "ab" * 32


_EFFECTIVE_CASES = {
    "plain": (f"ENCRYPTION_KEY={_KEY}\n", _KEY),
    "indented": (f"  ENCRYPTION_KEY={_KEY}\n", _KEY),
    "tab indented": (f"\tENCRYPTION_KEY={_KEY}\n", _KEY),
    "export": (f"export ENCRYPTION_KEY={_KEY}\n", _KEY),
    "indented export": (f"  export ENCRYPTION_KEY={_KEY}\n", _KEY),
    "colon": (f"ENCRYPTION_KEY: {_KEY}\n", _KEY),
    "colon no space": (f"ENCRYPTION_KEY:{_KEY}\n", _KEY),
    "colon spaced and indented": (f"  ENCRYPTION_KEY : {_KEY}\n", _KEY),
    "colon with export": (f"export ENCRYPTION_KEY: {_KEY}\n", _KEY),
    "spaces around equals": (f"ENCRYPTION_KEY = {_KEY}\n", _KEY),
    "inside a quoted multi-line value only": (f'NOTE="first\nENCRYPTION_KEY={_KEY}\nlast"\n', ""),
    "real key then a multi-line value that mentions it": (
        f'ENCRYPTION_KEY={_KEY}\nNOTE="first\nENCRYPTION_KEY=\nlast"\n',
        _KEY,
    ),
    "multi-line value then the real key": (
        f'NOTE="first\nENCRYPTION_KEY=\nlast"\nENCRYPTION_KEY={_KEY}\n',
        _KEY,
    ),
    "double quoted": (f'ENCRYPTION_KEY="{_KEY}"\n', _KEY),
    "single quoted": (f"ENCRYPTION_KEY='{_KEY}'\n", _KEY),
    "trailing comment": (f"ENCRYPTION_KEY={_KEY}  # backup this file\n", _KEY),
    "crlf": (f"ENCRYPTION_KEY={_KEY}\r\n", _KEY),
    "last assignment wins": (f"ENCRYPTION_KEY={'cd' * 32}\nENCRYPTION_KEY={_KEY}\n", _KEY),
    "last assignment is empty": (f"ENCRYPTION_KEY={_KEY}\nENCRYPTION_KEY=\n", ""),
    "commented out": (f"# ENCRYPTION_KEY={_KEY}\n", ""),
    "similar name": (f"OLD_ENCRYPTION_KEY={_KEY}\n", ""),
    "unset": ("OTHER=1\n", ""),
}


@pytest.mark.parametrize("text, expected", _EFFECTIVE_CASES.values(), ids=_EFFECTIVE_CASES.keys())
def test_every_reader_agrees_on_the_key_in_effect(tmp_path, text, expected):
    """env-secrets, the launcher and rotation must not disagree about which key is live."""
    from tmux_tools.launcher import effective_value

    env_file = tmp_path / ".env"
    env_file.write_text(text, newline="")
    shell = subprocess.run(
        ["sh", str(_ENV_VALUE), "get", "ENCRYPTION_KEY", str(env_file)],
        capture_output=True,
        text=True,
        check=True,
    ).stdout.strip()

    assert shell == expected
    assert effective_value(text, "ENCRYPTION_KEY") == expected


_VALID_FORMS = [k for k, (_, v) in _EFFECTIVE_CASES.items() if v == _KEY]


@pytest.mark.parametrize("form", _VALID_FORMS)
def test_startup_keeps_an_encryption_key_docker_compose_already_accepts(tmp_path, form):
    """A normal start must not add a second key line: a later line wins, orphaning stored keys."""
    from tmux_tools.launcher import effective_value

    text = _EFFECTIVE_CASES[form][0]
    (tmp_path / ".env.example").write_text("ENCRYPTION_KEY=\n")
    (tmp_path / ".env").write_text(text, newline="")

    _run_env_secrets(tmp_path)

    after = (tmp_path / ".env").read_text()
    assert effective_value(after, "ENCRYPTION_KEY") == _KEY
    assert after.count("ENCRYPTION_KEY") == text.count("ENCRYPTION_KEY")
    # The same holds for the launcher (make dev / make prod).
    assert effective_value(fill_secrets(text, ("ENCRYPTION_KEY",)), "ENCRYPTION_KEY") == _KEY
    assert fill_secrets(text, ("ENCRYPTION_KEY",)).count("ENCRYPTION_KEY") == text.count(
        "ENCRYPTION_KEY"
    )


def test_startup_repairs_the_assignment_compose_would_use(tmp_path):
    """An empty last assignment is what Compose sees, so that is the one to fill."""
    (tmp_path / ".env.example").write_text("ENCRYPTION_KEY=\n")
    (tmp_path / ".env").write_text(f"ENCRYPTION_KEY={_KEY}\n  ENCRYPTION_KEY=\n")

    _run_env_secrets(tmp_path)

    assert re.fullmatch(r"[0-9a-f]{64}", _values(tmp_path / ".env")["ENCRYPTION_KEY"].strip())


def _resolved(tmp_path: Path, key: str) -> str:
    return subprocess.run(
        ["sh", str(_ENV_VALUE), "get", key, str(tmp_path / ".env")],
        capture_output=True,
        text=True,
        check=True,
    ).stdout


def test_startup_adds_a_key_without_touching_a_multi_line_value_that_mentions_it(tmp_path):
    """The only matching line sits inside NOTE's value; editing it would corrupt NOTE."""
    note = 'NOTE="first\nENCRYPTION_KEY=\nlast"\n'
    (tmp_path / ".env.example").write_text("ENCRYPTION_KEY=\n")
    (tmp_path / ".env").write_text(note)

    _run_env_secrets(tmp_path)

    assert (tmp_path / ".env").read_text().startswith(note)
    assert re.fullmatch(r"[0-9a-f]{64}", _resolved(tmp_path, "ENCRYPTION_KEY"))


def test_startup_replaces_a_copied_secret_without_editing_a_look_alike_inside_a_value(tmp_path):
    text = 'INTERNAL_API_SECRET=dev-internal-secret\nNOTE="a\nINTERNAL_API_SECRET=other\nb"\n'
    (tmp_path / ".env.example").write_text("INTERNAL_API_SECRET=\n")
    (tmp_path / ".env").write_text(text)

    _run_env_secrets(tmp_path)

    after = (tmp_path / ".env").read_text()
    assert 'NOTE="a\nINTERNAL_API_SECRET=other\nb"' in after
    assert re.fullmatch(r"[0-9a-f]{64}", _resolved(tmp_path, "INTERNAL_API_SECRET"))


def test_startup_never_changes_the_key_compose_resolves_for_a_valid_multi_line_file(tmp_path):
    """A look-alike line after the real key must not make startup replace the real key."""
    text = f'ENCRYPTION_KEY={_KEY}\nNOTE="first\nENCRYPTION_KEY=\nlast"\n'
    (tmp_path / ".env.example").write_text("ENCRYPTION_KEY=\n")
    (tmp_path / ".env").write_text(text)

    _run_env_secrets(tmp_path)

    assert (tmp_path / ".env").read_text().startswith(text), "existing lines are left alone"
    assert _resolved(tmp_path, "ENCRYPTION_KEY") == _KEY
    assert fill_secrets(text, ("ENCRYPTION_KEY",)) == text


def _read_with_docker_stand_in(tmp_path: Path, body: str) -> subprocess.CompletedProcess:
    """Run the reader with a `docker` that behaves as `body` says."""
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    (bin_dir / "docker").write_text(f"#!/bin/sh\n{body}\n")
    (bin_dir / "docker").chmod(0o755)
    (tmp_path / ".env").write_text(f"ENCRYPTION_KEY={_KEY}\n")
    return subprocess.run(
        ["sh", str(_ENV_VALUE), "get", "ENCRYPTION_KEY", str(tmp_path / ".env")],
        capture_output=True,
        text=True,
        env={**os.environ, "PATH": f"{bin_dir}:{os.environ['PATH']}"},
    )


@pytest.mark.parametrize(
    "body",
    [
        "exit 1",
        "echo 'unexpected output'",
        "echo '{}'",
        "exit 0",
    ],
    ids=["docker fails", "not json", "no value line", "no output"],
)
def test_a_failed_read_is_never_reported_as_an_unset_key(tmp_path, body):
    """An empty value means 'not set'; a failure to read must be an error, not an empty value."""
    result = _read_with_docker_stand_in(tmp_path, body)

    assert result.returncode != 0
    assert result.stdout == ""
    assert "could not read" in result.stderr


def test_the_reader_does_not_depend_on_gnu_only_sed_features(tmp_path):
    """Stock macOS sed has no `T` command; the reader must not need sed at all."""
    result = _read_with_docker_stand_in(
        tmp_path,
        f"""printf '{{\\n  "services": {{\\n    "v": {{\\n      "environment": {{\\n        "V": "{_KEY}"\\n}}}}}}}}\\n'""",
    )
    assert result.returncode == 0, result.stderr
    assert result.stdout == _KEY
    code = [ln for ln in _ENV_VALUE.read_text().splitlines() if not ln.lstrip().startswith("#")]
    assert not [ln for ln in code if re.search(r"\bsed\b", ln)]
