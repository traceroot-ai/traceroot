"""A value published in this repository must never be usable as a secret.

.env.example and docker-compose.prod.yml both shipped working values for
INTERNAL_API_SECRET and BETTER_AUTH_SECRET, so any deployment that never
overrode them used a secret anyone can read here, and every local checkout used
the same one as every other. Three things have to hold together:

* prod compose must require the values rather than default them;
* the launcher must give each install its own, including a checkout whose .env
  still holds an old placeholder -- otherwise pulling this change turns a
  working local stack into a 503 loop;
* Settings must treat a published value as unset, since both call sites
  (routers/internal.py, routers/deps.py) already fail closed on an empty one.

The equivalent check for the TypeScript side lives in frontend/ui/src/env.ts.
"""

import os
import re
import stat
from pathlib import Path

import pytest

from shared.config import Settings
from tmux_tools.launcher import GENERATED_KEYS, ensure_env_file, fill_secrets

_ROOT = Path(__file__).resolve().parent.parent
_COMPOSE = _ROOT / "docker-compose.prod.yml"
_EXAMPLE = "FOO=bar\nINTERNAL_API_SECRET=\nBETTER_AUTH_SECRET=\n"


def _values(path: Path) -> dict[str, str]:
    """Parse .env the way a loader would, including the ``export KEY=`` form."""
    values = {}
    for line in path.read_text().splitlines():
        if "=" not in line or line.lstrip().startswith("#"):
            continue
        key, value = line.split("=", 1)
        values[key.strip().removeprefix("export ").strip()] = value
    return values


@pytest.fixture
def env(tmp_path: Path) -> tuple[Path, Path]:
    example = tmp_path / ".env.example"
    example.write_text(_EXAMPLE)
    return tmp_path / ".env", example


# --- deploy artifact ---------------------------------------------------------


@pytest.mark.parametrize("key", GENERATED_KEYS)
def test_prod_compose_requires_the_secret_rather_than_defaulting_it(key):
    """``${VAR:-something}`` would hand every install the same secret."""
    text = _COMPOSE.read_text()
    assert not re.findall(rf"\$\{{{key}:-[^}}]*\}}", text), f"{key} still has a fallback default"
    assert re.search(rf"\$\{{{key}:\?", text), f"{key} is not marked required"


# --- launcher ----------------------------------------------------------------


def test_fresh_clone_gets_generated_secrets(env):
    """cp .env.example .env leaves the keys empty; the launcher fills them."""
    env_path, example = env
    ensure_env_file(env_path, example)

    values = _values(env_path)
    assert all(len(values[key]) == 64 for key in GENERATED_KEYS)
    assert values["FOO"] == "bar", "unrelated keys must survive"


def test_two_installs_do_not_share_a_secret(env, tmp_path):
    """The whole point: generated per install, not committed."""
    env_path, example = env
    other = tmp_path / "other.env"
    ensure_env_file(env_path, example)
    ensure_env_file(other, example)

    assert _values(env_path)["INTERNAL_API_SECRET"] != _values(other)["INTERNAL_API_SECRET"]


@pytest.mark.parametrize(
    "line",
    [
        "INTERNAL_API_SECRET=dev-internal-secret",
        "INTERNAL_API_SECRET=internal-secret  # CHANGEME in production",
        "export INTERNAL_API_SECRET=dev-internal-secret",
        "INTERNAL_API_SECRET=CHANGEME",
    ],
)
def test_published_placeholder_is_repaired_in_place(env, line):
    """Including the ``export`` form: appending instead would win over a real value."""
    env_path, example = env
    env_path.write_text(f"{line}\nBETTER_AUTH_SECRET=\n")

    ensure_env_file(env_path, example)

    text = env_path.read_text()
    assert text.count("INTERNAL_API_SECRET") == 1, "repaired in place, not duplicated"
    assert len(_values(env_path)["INTERNAL_API_SECRET"]) == 64
    assert "CHANGEME" not in text


def test_operator_chosen_value_is_never_touched(env):
    """Only values this repository published are replaced -- nothing else."""
    env_path, example = env
    chosen = "my-own-deliberately-short-secret"
    env_path.write_text(f"INTERNAL_API_SECRET={chosen}\nBETTER_AUTH_SECRET={chosen}\n")

    ensure_env_file(env_path, example)

    assert _values(env_path)["INTERNAL_API_SECRET"] == chosen


def test_running_twice_is_stable(env):
    """The launcher calls this on every start."""
    env_path, example = env
    ensure_env_file(env_path, example)
    after_first = env_path.read_text()

    ensure_env_file(env_path, example)

    assert env_path.read_text() == after_first


def test_env_file_is_not_readable_by_other_users(env):
    """It holds generated secrets now, so 0644 from a plain copy is not enough."""
    env_path, example = env
    ensure_env_file(env_path, example)

    mode = stat.S_IMODE(os.stat(env_path).st_mode)
    assert not mode & (stat.S_IRGRP | stat.S_IROTH), f"mode is {mode:o}"


def test_missing_key_is_appended_without_joining_lines(env):
    """An .env predating a key, with no trailing newline, still comes out valid."""
    env_path, example = env
    env_path.write_text("FOO=bar")

    ensure_env_file(env_path, example)

    values = _values(env_path)
    assert values["FOO"] == "bar"
    assert all(len(values[key]) == 64 for key in GENERATED_KEYS)


def test_fill_secrets_leaves_a_configured_file_alone():
    text = "INTERNAL_API_SECRET=" + "a" * 64 + "\nBETTER_AUTH_SECRET=" + "b" * 64 + "\n"
    assert fill_secrets(text) == text


# --- backend settings --------------------------------------------------------


@pytest.mark.parametrize(
    "published", ["dev-internal-secret", "internal-secret", "changeme", "  Dev-Internal-Secret  "]
)
def test_published_default_is_treated_as_unset(published):
    assert Settings(internal_api_secret=published).internal_api_secret == ""


def test_a_real_secret_is_kept_verbatim():
    secret = "a3f9c1d0b7e24856" * 4
    assert Settings(internal_api_secret=secret).internal_api_secret == secret
