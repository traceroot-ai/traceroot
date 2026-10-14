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
  (routers/internal/auth.py, routers/deps.py) already fail closed on an empty one.

The equivalent check for the TypeScript side lives in frontend/ui/src/env.ts.
"""

import os
import re
import stat
import subprocess
from pathlib import Path

import pytest

from shared.config import Settings
from tmux_tools.launcher import (
    ALL_GENERATED_KEYS,
    GENERATED_KEYS,
    _teardown_env,
    ensure_env_file,
    fill_secrets,
    is_placeholder,
)

_ROOT = Path(__file__).resolve().parent.parent
_COMPOSE = _ROOT / "docker-compose.prod.yml"
_MAKEFILE = _ROOT / "Makefile"
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


@pytest.mark.parametrize("key", ALL_GENERATED_KEYS)
def test_prod_compose_requires_the_secret_rather_than_defaulting_it(key):
    """``${VAR:-something}`` would hand every install the same secret."""
    text = _COMPOSE.read_text()
    assert not re.findall(rf"\$\{{{key}:-[^}}]*\}}", text), f"{key} still has a fallback default"
    assert re.search(rf"\$\{{{key}:\?", text), f"{key} is not marked required"


def _compose_required_secrets() -> set[str]:
    """Every key prod compose refuses to start without."""
    return set(re.findall(r"\$\{([A-Z_]+):\?", _COMPOSE.read_text()))


def _makefile_required_secrets() -> set[str]:
    match = re.search(r"^REQUIRED_SECRETS\s*:=\s*(.*)$", _MAKEFILE.read_text(), re.MULTILINE)
    assert match, "Makefile no longer declares REQUIRED_SECRETS"
    return set(match.group(1).split())


def test_every_required_secret_is_generated_for_the_operator():
    """A key compose demands but nothing generates makes the quickstart abort.

    SQL_GATEWAY_BOOTSTRAP_PASSWORD was exactly that: marked required in three
    places, shipped commented out, and absent from GENERATED_KEYS, so
    ``cp .env.example .env && make prod-lite`` died on the first gate.
    """
    assert _compose_required_secrets() <= set(ALL_GENERATED_KEYS)


def test_prod_lite_generates_the_same_set_without_the_python_toolchain():
    """prod-lite cannot call the launcher, so its own list must not drift."""
    assert _makefile_required_secrets() == _compose_required_secrets()


def _run_env_secrets(workdir: Path) -> None:
    """Run the Makefile's own env-secrets recipe in an isolated directory.

    Parsing the recipe instead of restating it means these two tests cannot
    drift from what an operator actually runs.
    """
    text = _MAKEFILE.read_text()
    start = text.index("env-secrets:\n") + len("env-secrets:\n")
    body = []
    for line in text[start:].splitlines(keepends=True):
        if line.strip() and not line.startswith("\t"):
            break
        body.append(line)
    script = "".join(body).replace("\t", "").replace("$$", "$")
    script = script.replace("$(REQUIRED_SECRETS)", " ".join(sorted(_makefile_required_secrets())))
    script = re.sub(r"^@", "", script, flags=re.MULTILINE)
    subprocess.run(["sh", "-e", "-c", script], cwd=workdir, check=True, capture_output=True)


def test_generated_env_is_not_readable_by_other_users(tmp_path):
    """env-secrets writes real secrets, so 0644 from a plain copy is not enough.

    The recipe builds a temp file and ``mv``s it over .env, which replaces the
    inode and discards the mode, so the 0600 the launcher sets deliberately was
    undone on the self-hosting path.
    """
    (tmp_path / ".env.example").write_text("INTERNAL_API_SECRET=\n")

    _run_env_secrets(tmp_path)

    mode = stat.S_IMODE(os.stat(tmp_path / ".env").st_mode)
    assert not mode & (stat.S_IRGRP | stat.S_IROTH), f"mode is {mode:o}"


def test_an_exported_secret_is_left_alone(tmp_path):
    """``export KEY=value`` is a configured secret, not an absent one.

    The detector splits on ``=``, so without stripping the prefix the name reads
    as "export KEY", the value looks empty, and an appended generated line wins
    under dotenv last-one-wins.
    """
    chosen = "an-operator-chosen-production-secret"
    (tmp_path / ".env.example").write_text("INTERNAL_API_SECRET=\n")
    (tmp_path / ".env").write_text(f"export INTERNAL_API_SECRET={chosen}\n")

    _run_env_secrets(tmp_path)

    body = (tmp_path / ".env").read_text()
    assert body.count("INTERNAL_API_SECRET=") == 1, body
    assert chosen in body


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
    assert text.count("INTERNAL_API_SECRET=") == 1, "repaired in place, not duplicated"
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


@pytest.mark.parametrize(
    "value", ["changeme#custom-suffix", "internal-secret-but-longer", "a1b2#c3d4"]
)
def test_a_secret_that_merely_contains_a_hash_is_kept(value):
    """Only whitespace before ``#`` opens a comment, so these are real values."""
    assert not is_placeholder(value)
    assert fill_secrets(f"INTERNAL_API_SECRET={value}\nBETTER_AUTH_SECRET=x\n").startswith(
        f"INTERNAL_API_SECRET={value}"
    )


def test_trailing_comment_still_marks_a_placeholder():
    assert is_placeholder("internal-secret  # CHANGEME in production")


def test_teardown_does_not_need_real_secrets():
    """Compose interpolates required vars even for ``down``; a reset must not fail."""
    env = _teardown_env()
    assert all(env[key] for key in ALL_GENERATED_KEYS)


def test_teardown_prefers_a_value_the_operator_already_set(monkeypatch):
    monkeypatch.setenv("INTERNAL_API_SECRET", "operator-value")
    assert _teardown_env()["INTERNAL_API_SECRET"] == "operator-value"


def test_fill_secrets_leaves_a_configured_file_alone():
    """Derived from GENERATED_KEYS so adding a key cannot silently skip it here."""
    text = "".join(
        f"{key}=" + chr(ord("a") + i) * 64 + "\n" for i, key in enumerate(GENERATED_KEYS)
    )
    assert fill_secrets(text) == text


def test_dev_path_leaves_the_prod_only_secret_alone(env):
    """docker-compose.yml defaults it, so writing a value breaks an existing
    dev volume that ClickHouse initialised with that default."""
    env_path, example = env
    ensure_env_file(env_path, example)

    assert "SQL_GATEWAY_BOOTSTRAP_PASSWORD" not in _values(env_path)


def test_prod_path_fills_the_prod_only_secret(env):
    env_path, example = env
    ensure_env_file(env_path, example, keys=ALL_GENERATED_KEYS)

    assert len(_values(env_path)["SQL_GATEWAY_BOOTSTRAP_PASSWORD"]) == 64


# --- backend settings --------------------------------------------------------


@pytest.mark.parametrize(
    "published", ["dev-internal-secret", "internal-secret", "changeme", "  Dev-Internal-Secret  "]
)
def test_published_default_is_treated_as_unset(published):
    assert Settings(internal_api_secret=published).internal_api_secret == ""


def test_a_real_secret_is_kept_verbatim():
    secret = "a3f9c1d0b7e24856" * 4
    assert Settings(internal_api_secret=secret).internal_api_secret == secret
