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


def test_prod_lite_never_replaces_an_encryption_key_that_is_set(tmp_path):
    """Stored provider keys are encrypted under it; replacing it would orphan them."""
    example_key = "9cf7ec27e77884f3d76dda6312f55317b2b6fff317e5b09d4a9ad7b20eff5e00"
    (tmp_path / ".env.example").write_text("ENCRYPTION_KEY=\n")
    (tmp_path / ".env").write_text(f"ENCRYPTION_KEY={example_key}\n")
    _run_env_secrets(tmp_path)
    assert _values(tmp_path / ".env")["ENCRYPTION_KEY"] == example_key


def test_launcher_fills_an_empty_encryption_key_but_keeps_a_set_one():
    assert re.search(r"ENCRYPTION_KEY=[0-9a-f]{64}", fill_secrets("ENCRYPTION_KEY=\n"))
    text = "ENCRYPTION_KEY=changeme\n"
    assert fill_secrets(text, ("ENCRYPTION_KEY",)) == text


def test_the_dev_path_fills_the_encryption_key(tmp_path):
    env_path, example = tmp_path / ".env", tmp_path / ".env.example"
    example.write_text("INTERNAL_API_SECRET=\nBETTER_AUTH_SECRET=\n")
    ensure_env_file(env_path, example)
    assert re.fullmatch(r"[0-9a-f]{64}", _values(env_path)["ENCRYPTION_KEY"])


_ENV_VALUE = _ROOT / "scripts" / "env-value.sh"
_KEY = "ab" * 32

# (.env text, the key Docker Compose resolves for it)
_EFFECTIVE_CASES = {
    "plain": (f"ENCRYPTION_KEY={_KEY}\n", _KEY),
    "indented export": (f"  export ENCRYPTION_KEY={_KEY}\n", _KEY),
    "colon": (f"ENCRYPTION_KEY: {_KEY}\n", _KEY),
    "double quoted": (f'ENCRYPTION_KEY="{_KEY}"\n', _KEY),
    "trailing comment": (f"ENCRYPTION_KEY={_KEY}  # backup this file\n", _KEY),
    "crlf": (f"ENCRYPTION_KEY={_KEY}\r\n", _KEY),
    "last assignment wins": (f"ENCRYPTION_KEY={'cd' * 32}\nENCRYPTION_KEY={_KEY}\n", _KEY),
    "last assignment is empty": (f"ENCRYPTION_KEY={_KEY}\nENCRYPTION_KEY=\n", ""),
    "real key then a multi-line value that mentions it": (
        f'ENCRYPTION_KEY={_KEY}\nNOTE="first\nENCRYPTION_KEY=\nlast"\n',
        _KEY,
    ),
    "mentioned only inside a multi-line value": (
        f'NOTE="first\nENCRYPTION_KEY={_KEY}\nlast"\n',
        "",
    ),
    "commented out": (f"# ENCRYPTION_KEY={_KEY}\n", ""),
    "similar name": (f"OLD_ENCRYPTION_KEY={_KEY}\n", ""),
}


def _resolved(env_file: Path, key: str = "ENCRYPTION_KEY") -> str:
    return subprocess.run(
        ["sh", str(_ENV_VALUE), "get", key, str(env_file)],
        capture_output=True,
        text=True,
        check=True,
    ).stdout


@pytest.mark.parametrize("text, expected", _EFFECTIVE_CASES.values(), ids=_EFFECTIVE_CASES.keys())
def test_the_reader_returns_the_key_docker_compose_resolves(tmp_path, text, expected):
    (tmp_path / ".env").write_text(text, newline="")

    assert _resolved(tmp_path / ".env") == expected


_VALID_FORMS = [k for k, (_, v) in _EFFECTIVE_CASES.items() if v == _KEY]


@pytest.mark.parametrize("form", _VALID_FORMS)
def test_startup_keeps_an_encryption_key_docker_compose_already_accepts(tmp_path, form):
    """A normal start must not add a second key line: a later line wins, orphaning stored keys."""
    text = _EFFECTIVE_CASES[form][0]
    (tmp_path / ".env.example").write_text("ENCRYPTION_KEY=\n")
    (tmp_path / ".env").write_text(text, newline="")

    _run_env_secrets(tmp_path)

    after = (tmp_path / ".env").read_text()
    assert _resolved(tmp_path / ".env") == _KEY
    assert after.count("ENCRYPTION_KEY") == text.count("ENCRYPTION_KEY")
    filled = fill_secrets(text, ("ENCRYPTION_KEY",))
    assert filled.count("ENCRYPTION_KEY") == text.count("ENCRYPTION_KEY"), "the launcher agrees"


def test_startup_repairs_the_assignment_compose_would_use(tmp_path):
    """An empty last assignment is what Compose sees, so that is the one to fill."""
    (tmp_path / ".env.example").write_text("ENCRYPTION_KEY=\n")
    (tmp_path / ".env").write_text(f"ENCRYPTION_KEY={_KEY}\n  ENCRYPTION_KEY=\n")

    _run_env_secrets(tmp_path)

    assert re.fullmatch(r"[0-9a-f]{64}", _resolved(tmp_path / ".env"))


def test_startup_adds_a_key_without_touching_a_multi_line_value_that_mentions_it(tmp_path):
    """The only matching line sits inside NOTE's value; editing it would corrupt NOTE."""
    note = 'NOTE="first\nENCRYPTION_KEY=\nlast"\n'
    (tmp_path / ".env.example").write_text("ENCRYPTION_KEY=\n")
    (tmp_path / ".env").write_text(note)

    _run_env_secrets(tmp_path)

    assert (tmp_path / ".env").read_text().startswith(note)
    assert re.fullmatch(r"[0-9a-f]{64}", _resolved(tmp_path / ".env"))


def test_startup_replaces_a_copied_secret_without_editing_a_look_alike_inside_a_value(tmp_path):
    text = 'INTERNAL_API_SECRET=dev-internal-secret\nNOTE="a\nINTERNAL_API_SECRET=other\nb"\n'
    (tmp_path / ".env.example").write_text("INTERNAL_API_SECRET=\n")
    (tmp_path / ".env").write_text(text)

    _run_env_secrets(tmp_path)

    assert 'NOTE="a\nINTERNAL_API_SECRET=other\nb"' in (tmp_path / ".env").read_text()
    assert re.fullmatch(r"[0-9a-f]{64}", _resolved(tmp_path / ".env", "INTERNAL_API_SECRET"))


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
    "body", ["exit 1", "echo '{}'"], ids=["docker fails", "output without the value"]
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


def test_inherited_process_env_var_does_not_shadow_target_env_file(tmp_path, monkeypatch):
    """Caller's exported env var (e.g. from root .env) must not override --env-file."""
    env_file = tmp_path / ".env"
    file_value = "file_value_123"
    updated_value = "updated_value_456"
    env_file.write_text(f"ENCRYPTION_KEY={file_value}\n")
    monkeypatch.setenv("ENCRYPTION_KEY", "caller_shell_shadow_value")

    got = subprocess.run(
        ["sh", str(_ENV_VALUE), "get", "ENCRYPTION_KEY", str(env_file)],
        capture_output=True,
        text=True,
        check=True,
    )
    assert got.stdout == file_value

    updated = subprocess.run(
        ["sh", str(_ENV_VALUE), "set", "ENCRYPTION_KEY", str(env_file)],
        capture_output=True,
        text=True,
        env={**os.environ, "ENV_VALUE_NEW": updated_value},
        check=True,
    )
    assert f"ENCRYPTION_KEY={updated_value}" in updated.stdout
