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
import shutil
import stat
import subprocess
from pathlib import Path

import pytest

from shared.config import Settings
from tmux_tools.launcher import (
    ALL_GENERATED_KEYS,
    GENERATED_KEYS,
    PUBLISHED_PLACEHOLDERS,
    _teardown_env,
    ensure_env_file,
    fill_secrets,
    is_placeholder,
    run_env_only,
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


def _makefile_list(name: str) -> list[str]:
    """One ``NAME := a b c`` Makefile variable, backslash continuations joined."""
    match = re.search(rf"^{name}\s*:=\s*((?:[^\n\\]|\\\n)*)", _MAKEFILE.read_text(), re.MULTILINE)
    assert match, f"Makefile no longer declares {name}"
    return match.group(1).replace("\\\n", " ").split()


def _makefile_required_secrets() -> set[str]:
    return set(_makefile_list("REQUIRED_SECRETS"))


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


def _makefile_recipe(target: str) -> str:
    """The recipe lines of one Makefile target, tabs and continuations intact."""
    text = _MAKEFILE.read_text()
    match = re.search(rf"^{re.escape(target)}:.*$", text, re.MULTILINE)
    assert match, f"Makefile no longer declares the {target} target"
    body = []
    for line in text[match.end() + 1 :].splitlines(keepends=True):
        if line.strip() and not line.startswith("\t"):
            break
        body.append(line)
    return "".join(body)


def _run_env_secrets(
    workdir: Path, extra_path: Path | None = None, check: bool = True
) -> subprocess.CompletedProcess:
    """Run the Makefile's own env-secrets recipe in an isolated directory.

    Parsing the recipe instead of restating it means these tests cannot drift
    from what an operator actually runs. ``extra_path`` goes in front of PATH, so
    a test can make one of the tools the recipe shells out to fail.
    """
    script = _makefile_recipe("env-secrets")
    script = script.replace("$(REQUIRED_SECRETS)", " ".join(sorted(_makefile_required_secrets())))
    script = script.replace(
        "$(PUBLISHED_PLACEHOLDERS)", " ".join(sorted(_makefile_list("PUBLISHED_PLACEHOLDERS")))
    )
    # A make variable nobody expanded would reach sh as the empty string, which
    # here would mean silently testing against an empty placeholder list.
    leftover = re.search(r"(?<!\$)\$\([^)]*\)", script)
    assert leftover is None, f"unexpanded make variable {leftover.group() if leftover else ''}"
    script = script.replace("\t", "").replace("$$", "$")
    script = re.sub(r"^@", "", script, flags=re.MULTILINE)
    env = dict(os.environ)
    if extra_path is not None:
        env["PATH"] = f"{extra_path}:{env['PATH']}"
    return subprocess.run(
        ["sh", "-e", "-c", script], cwd=workdir, check=check, capture_output=True, env=env
    )


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


def test_prod_lite_and_the_launcher_agree_on_what_this_repo_published():
    """Two paths repair the same .env, so one knowing fewer placeholders is a hole."""
    assert set(_makefile_list("PUBLISHED_PLACEHOLDERS")) == set(PUBLISHED_PLACEHOLDERS)


@pytest.mark.parametrize(
    "line",
    [
        "SQL_GATEWAY_BOOTSTRAP_PASSWORD=dev-sql-gateway-bootstrap  # CHANGEME",
        "SQL_GATEWAY_BOOTSTRAP_PASSWORD=Dev-SQL-Gateway-Bootstrap",
        'SQL_GATEWAY_BOOTSTRAP_PASSWORD="dev-sql-gateway-bootstrap"',
        "export SQL_GATEWAY_BOOTSTRAP_PASSWORD=dev-sql-gateway-bootstrap",
        "SQL_GATEWAY_BOOTSTRAP_PASSWORD=   # CHANGEME",
    ],
)
def test_prod_lite_replaces_a_published_bootstrap_password(tmp_path, line):
    """An upgraded checkout keeps its old .env, and this value was published here.

    It is the only account holding ClickHouse access management, so treating the
    published string as configured would leave that account openable by anyone
    who read this repository. Testing only nonemptiness did exactly that.
    """
    (tmp_path / ".env.example").write_text("SQL_GATEWAY_BOOTSTRAP_PASSWORD=\n")
    (tmp_path / ".env").write_text(f"{line}\n")

    _run_env_secrets(tmp_path)

    body = (tmp_path / ".env").read_text()
    assert body.count("SQL_GATEWAY_BOOTSTRAP_PASSWORD=") == 1, body
    assert "dev-sql-gateway-bootstrap" not in body.lower()
    assert "CHANGEME" not in body
    assert len(_values(tmp_path / ".env")["SQL_GATEWAY_BOOTSTRAP_PASSWORD"]) == 64


@pytest.mark.parametrize(
    "line",
    [
        "SQL_GATEWAY_BOOTSTRAP_PASSWORD=dev-sql-gateway-bootstrap",
        'SQL_GATEWAY_BOOTSTRAP_PASSWORD="dev-sql-gateway-bootstrap"',
        "SQL_GATEWAY_BOOTSTRAP_PASSWORD=dev-sql-gateway-bootstrap  # CHANGEME",
    ],
)
def test_a_crlf_env_cannot_hide_a_published_password(tmp_path, line):
    """An operator who edited .env on Windows must not keep the published value.

    The parser trimmed spaces and tabs but not the carriage return, so the value
    compared as "dev-sql-gateway-bootstrap\\r" -- which matches no placeholder, so
    the recipe read it as configured and left it alone. Compose strips the
    carriage return as a line ending, so ClickHouse then ran with the password
    this repository publishes.
    """
    (tmp_path / ".env.example").write_text("SQL_GATEWAY_BOOTSTRAP_PASSWORD=\n")
    (tmp_path / ".env").write_bytes(f"{line}\r\nOTHER=keep\r\n".encode())

    _run_env_secrets(tmp_path)

    body = (tmp_path / ".env").read_text()
    assert "dev-sql-gateway-bootstrap" not in body.lower(), body
    assert body.count("SQL_GATEWAY_BOOTSTRAP_PASSWORD=") == 1, body
    assert len(_values(tmp_path / ".env")["SQL_GATEWAY_BOOTSTRAP_PASSWORD"]) == 64
    assert "OTHER=keep" in body


def test_whitespace_before_the_equals_is_repaired_in_place(tmp_path):
    """The two passes have to agree on where the name ends.

    The detect pass trimmed trailing whitespace from the name and the write pass
    did not, so "KEY =published" was recognised as needing replacement and then
    matched nothing to replace: the new value was appended and the published one
    stayed in the file.
    """
    (tmp_path / ".env.example").write_text("SQL_GATEWAY_BOOTSTRAP_PASSWORD=\n")
    (tmp_path / ".env").write_text("SQL_GATEWAY_BOOTSTRAP_PASSWORD =changeme\nOTHER=keep\n")

    _run_env_secrets(tmp_path)

    body = (tmp_path / ".env").read_text()
    assert "changeme" not in body, body
    assert body.count("SQL_GATEWAY_BOOTSTRAP_PASSWORD") == 1, body
    assert len(_values(tmp_path / ".env")["SQL_GATEWAY_BOOTSTRAP_PASSWORD"]) == 64
    assert "OTHER=keep" in body


def test_env_stays_private_when_secret_generation_fails(tmp_path):
    """The recipe can abort between reading .env and writing it back.

    chmod used to run after the loop, so an openssl that failed -- missing, or
    out of entropy -- left an .env full of earlier secrets at whatever mode it
    already had.
    """
    (tmp_path / ".env.example").write_text("INTERNAL_API_SECRET=\n")
    env_path = tmp_path / ".env"
    env_path.write_text("INTERNAL_API_SECRET=\n")
    os.chmod(env_path, 0o644)
    stub = tmp_path / "bin"
    stub.mkdir()
    (stub / "openssl").write_text("#!/bin/sh\nexit 1\n")
    # 0o700: the stub only ever has to be executable by the test's own user.
    os.chmod(stub / "openssl", 0o700)

    done = _run_env_secrets(tmp_path, extra_path=stub, check=False)

    assert done.returncode != 0, "a failed generation must not look like success"
    mode = stat.S_IMODE(os.stat(env_path).st_mode)
    assert not mode & (stat.S_IRGRP | stat.S_IROTH), f"mode is {mode:o}"


def test_a_symlink_at_the_old_fixed_temp_name_is_never_written_through(tmp_path):
    """A regression guard for the fixed `.env.tmp` this recipe used to write.

    Shell redirection follows a symlink and umask does not protect a target that
    already exists, so anyone able to write the checkout could pre-create that
    path as a symlink to a file they own and every generated secret went through
    it -- .env ending up mode 0600 says nothing, because the bytes went
    somewhere else first. The recipe now asks mktemp for the name, so this
    guards only against going back to a name an outsider can predict; the test
    below is the one that holds whatever name is used.
    """
    (tmp_path / ".env.example").write_text("INTERNAL_API_SECRET=\n")
    (tmp_path / ".env").write_text("INTERNAL_API_SECRET=\n")
    captured = tmp_path / "captured"
    captured.write_text("")
    (tmp_path / ".env.tmp").symlink_to(captured)

    _run_env_secrets(tmp_path)

    assert captured.read_text() == "", f"secrets reached the planted file: {captured.read_text()}"
    env_path = tmp_path / ".env"
    assert not env_path.is_symlink(), ".env must not be left as a symlink"
    assert len(_values(env_path)["INTERNAL_API_SECRET"]) == 64
    mode = stat.S_IMODE(os.stat(env_path).st_mode)
    assert not mode & (stat.S_IRGRP | stat.S_IROTH), f"mode is {mode:o}"


def test_no_generated_secret_is_left_anywhere_but_env(tmp_path):
    """The property that holds whatever the temp file is called.

    A name-specific test cannot cover this: the rewrite target is now whatever
    mktemp returns, which is the point -- an outsider cannot pre-plant it. So
    assert the invariant instead. Every generated secret must end up in .env and
    nowhere else under the checkout, which fails for any implementation that
    writes through a planted symlink, leaves its temp file behind, or picks a
    predictable name an attacker captured.
    """
    (tmp_path / ".env.example").write_text(
        "INTERNAL_API_SECRET=\nBETTER_AUTH_SECRET=\nSQL_GATEWAY_BOOTSTRAP_PASSWORD=\n"
    )
    (tmp_path / ".env").write_text(
        "INTERNAL_API_SECRET=\nBETTER_AUTH_SECRET=\nSQL_GATEWAY_BOOTSTRAP_PASSWORD=\n"
    )
    # Plant the predictable candidates an earlier implementation would have used.
    for name in [".env.tmp", f".env.tmp.{os.getpid()}"]:
        (tmp_path / f"capture-{name}").write_text("")
        (tmp_path / name).symlink_to(tmp_path / f"capture-{name}")

    _run_env_secrets(tmp_path)

    env_path = tmp_path / ".env"
    secrets = set(_values(env_path).values())
    assert len(secrets) == 3, f"expected three generated secrets, got {secrets}"
    assert all(len(v) == 64 for v in secrets), secrets

    leaked = []
    for path in tmp_path.rglob("*"):
        if path == env_path or path.is_symlink() or not path.is_file():
            continue
        try:
            body = path.read_text()
        except (UnicodeDecodeError, OSError):
            continue
        for secret in secrets:
            if secret in body:
                leaked.append(str(path.relative_to(tmp_path)))
    assert not leaked, f"a generated secret reached {leaked}"

    assert not env_path.is_symlink(), ".env must not be left as a symlink"
    mode = stat.S_IMODE(os.stat(env_path).st_mode)
    assert not mode & (stat.S_IRGRP | stat.S_IROTH), f"mode is {mode:o}"
    strays = [
        p.name for p in tmp_path.iterdir() if p.name.startswith(".env.tmp") and not p.is_symlink()
    ]
    assert not strays, f"temp files left behind: {strays}"


def test_a_symlink_planted_at_env_itself_is_replaced_not_followed(tmp_path):
    """The last step renames over .env, so a symlink there must not be a channel.

    Nothing in the review raised this, but it is the same class as the temp-file
    finding and the rewrite would be pointless if the final step leaked. `mv` is
    a rename: it replaces the name, so the planted link is discarded and the file
    it pointed at is untouched.
    """
    (tmp_path / ".env.example").write_text("INTERNAL_API_SECRET=\n")
    victim = tmp_path / "victim"
    victim.write_text("untouched\n")
    (tmp_path / ".env").symlink_to(victim)

    _run_env_secrets(tmp_path)

    env_path = tmp_path / ".env"
    assert not env_path.is_symlink(), ".env must be a real file afterwards"
    assert victim.read_text() == "untouched\n", f"wrote through the link: {victim.read_text()}"
    assert len(_values(env_path)["INTERNAL_API_SECRET"]) == 64
    mode = stat.S_IMODE(os.stat(env_path).st_mode)
    assert not mode & (stat.S_IRGRP | stat.S_IROTH), f"mode is {mode:o}"


def _openssl_emitting(tmp_path: Path, value: str) -> Path:
    """A PATH stub whose ``openssl rand -hex 32`` prints exactly ``value``."""
    stub = tmp_path / "bin"
    stub.mkdir(exist_ok=True)
    payload = tmp_path / "payload"
    payload.write_text(value)
    (stub / "openssl").write_text(f'#!/bin/sh\ncat "{payload}"\nprintf "\\n"\n')
    # 0o700: the stub only ever has to be executable by the test's own user.
    os.chmod(stub / "openssl", 0o700)
    return stub


def test_generated_secret_never_becomes_a_command_line_argument(tmp_path):
    """A process argument list is readable by every local user; .env 0600 is not enough.

    ``ps -ef`` and a world-readable /proc/<pid>/cmdline hand any unprivileged
    account on the host every argument of every running process, so a secret
    passed as ``awk -v v=$value`` was readable for the lifetime of that awk.
    A process *environment* carries no such exposure -- /proc/<pid>/environ is
    gated by a ptrace credentials check -- so the value goes through ENVIRON.

    Each tool the recipe shells out to is shadowed by a wrapper that logs its own
    argv and then execs the real one, so the recipe still does its real work.
    """
    (tmp_path / ".env.example").write_text("INTERNAL_API_SECRET=\n")
    stub = tmp_path / "bin"
    stub.mkdir()
    log = tmp_path / "argv.log"
    for tool in ("awk", "printf", "cp", "mv", "sed"):
        real = shutil.which(tool)
        if real is None:
            continue
        (stub / tool).write_text(
            f'#!/bin/sh\nfor a in "$@"; do printf "%s\\n" "$a" >> "{log}"; done\n'
            f'exec "{real}" "$@"\n'
        )
        os.chmod(stub / tool, 0o700)

    _run_env_secrets(tmp_path, extra_path=stub)

    generated = _values(tmp_path / ".env")["INTERNAL_API_SECRET"]
    assert len(generated) == 64, generated
    recorded = log.read_text()
    assert generated not in recorded, f"secret reached a child argv:\n{recorded}"


@pytest.mark.parametrize(
    "value",
    [
        "amper&sand",
        "back\\slash",
        "back\\&both",
        "escape\\tsequence",
        "group\\1backref",
        "for/ward/slashes",
        'double"quote',
        "single'quote",
        "percent%sformat",
        "dollar$and`backtick`",
    ],
)
def test_a_generated_value_with_metacharacters_is_written_verbatim(tmp_path, value):
    """Keeping the secret out of argv must not hand it to something that rewrites it.

    The substitution tool decides this: sed would read ``&`` as the whole match
    and ``\1`` as a group, printf would read ``%s`` as a conversion, and awk's
    own ``-v`` assignment expanded escape sequences, so ``a\tb`` arrived as a
    tab. awk's ``print`` of an ENVIRON value interprets none of them.
    """
    (tmp_path / ".env.example").write_text("INTERNAL_API_SECRET=\n")
    (tmp_path / ".env").write_text("INTERNAL_API_SECRET=changeme\n")

    _run_env_secrets(tmp_path, extra_path=_openssl_emitting(tmp_path, value))

    body = (tmp_path / ".env").read_text()
    assert f"INTERNAL_API_SECRET={value}\n" in body, body
    assert body.count("INTERNAL_API_SECRET=") == 1, body


def test_recipe_appends_to_an_env_without_a_trailing_newline(tmp_path):
    """An .env predating a key, with no final newline, must not come out joined.

    ``printf >> .env.tmp`` wrote straight onto the last line, so ``FOO=bar`` and
    the appended key became ``FOO=barBETTER_AUTH_SECRET=...`` -- one unreadable
    line that loses both. awk ends every record it prints, so the seam is gone.
    """
    (tmp_path / ".env.example").write_text(_EXAMPLE)
    (tmp_path / ".env").write_text("FOO=bar")

    _run_env_secrets(tmp_path)

    values = _values(tmp_path / ".env")
    assert values["FOO"] == "bar", (tmp_path / ".env").read_text()
    for key in _makefile_required_secrets():
        assert len(values[key]) == 64, (tmp_path / ".env").read_text()


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
    """docker-compose.yml supplies it as one of the dev stack's known defaults,
    so `make dev` has nothing to repair and .env stays silent about it."""
    env_path, example = env
    ensure_env_file(env_path, example)

    assert "SQL_GATEWAY_BOOTSTRAP_PASSWORD" not in _values(env_path)


def test_dev_lite_runs_prod_compose_through_env_only():
    """Why --env-only fills the prod set: the target it serves runs prod compose."""
    recipe = _makefile_recipe("dev-lite")
    assert "--env-only" in recipe
    assert "$(PROD_COMPOSE) up" in recipe


def test_env_only_fills_every_secret_prod_compose_requires(env):
    """dev-lite aborted on the prod-only ${VAR:?} gate while this filled dev keys."""
    env_path, example = env
    run_env_only(env_path, example)

    values = _values(env_path)
    assert all(len(values[key]) == 64 for key in ALL_GENERATED_KEYS)


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
