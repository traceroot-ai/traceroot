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
    generated = _makefile_required_secrets() | set(_makefile_list("FRESH_ONLY_SECRETS"))
    assert generated == _compose_required_secrets()


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
    script = script.replace("$(FRESH_ONLY_SECRETS)", " ".join(_makefile_list("FRESH_ONLY_SECRETS")))
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
    expected = len(_makefile_required_secrets()) + len(_makefile_list("FRESH_ONLY_SECRETS"))
    assert len(secrets) == expected, f"expected {expected} generated secrets, got {secrets}"
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


@pytest.mark.parametrize("kind", ["file", "directory"])
def test_a_symlinked_env_is_refused_rather_than_written_through(tmp_path, kind):
    """`.env` being a symlink is an ambiguity this recipe must not resolve silently.

    `mv` replaces a symlink to a regular file, but a symlink to a *directory*
    makes it move the file **inside** that directory -- so the secret lands
    wherever the link's owner chose, and `.env` is still a link. `mv -T` would
    forbid that but is GNU only. Refusing is portable and leaves nothing to race.
    """
    (tmp_path / ".env.example").write_text("INTERNAL_API_SECRET=\n")
    if kind == "file":
        target = tmp_path / "captured"
        target.write_text("")
    else:
        target = tmp_path / "captured-dir"
        target.mkdir()
    (tmp_path / ".env").symlink_to(target)

    done = _run_env_secrets(tmp_path, check=False)

    assert done.returncode != 0, "a symlinked .env must stop the recipe"
    assert b"symlink" in done.stderr.lower(), done.stderr
    if kind == "file":
        assert target.read_text() == "", f"wrote through the link: {target.read_text()}"
    else:
        assert list(target.iterdir()) == [], f"wrote into the directory: {list(target.iterdir())}"
    assert (tmp_path / ".env").is_symlink(), "the link is left alone, not replaced"


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


# --- storage and database credentials -----------------------------------------

_DEV_COMPOSE = _ROOT / "docker-compose.yml"
_ENV_EXAMPLE = _ROOT / ".env.example"
_COPIED_VALUES = ("clickhouse", "minio-password")


@pytest.mark.parametrize("key", ["CLICKHOUSE_PASSWORD", "MINIO_ROOT_PASSWORD", "ENCRYPTION_KEY"])
def test_prod_compose_has_no_fallback_for_the_new_required_values(key):
    text = _COMPOSE.read_text()
    assert not re.findall(rf"\$\{{{key}:-[^}}]*\}}", text), f"{key} still has a fallback default"
    assert re.search(rf"\$\{{{key}:\?", text), f"{key} is not marked required"


def test_prod_compose_object_store_credentials_are_the_root_credentials():
    """One variable, not two that can drift: apps sign in as the account minio starts with."""
    text = _COMPOSE.read_text()
    assert "S3_SECRET_ACCESS_KEY: ${MINIO_ROOT_PASSWORD" in text
    assert not re.search(r"\$\{S3_(ACCESS_KEY_ID|SECRET_ACCESS_KEY)", text)


@pytest.mark.parametrize("compose", [_COMPOSE, _DEV_COMPOSE])
def test_object_store_api_is_only_published_on_loopback(compose):
    published = [
        line.strip()
        for line in compose.read_text().splitlines()
        if re.match(r"\s*- \"?(\d{1,3}(\.\d{1,3}){3}:)?\d+:9000\"?\s*$", line)
    ]
    assert published, "the object store port mapping moved; update this test"
    assert all(line.startswith("- 127.0.0.1:") for line in published), published


def _compose_service(name: str) -> dict:
    yaml = pytest.importorskip("yaml")
    return yaml.safe_load(_COMPOSE.read_text())["services"][name]


@pytest.mark.parametrize(
    "service",
    ["clickhouse", "minio", "web", "rest", "worker", "billing", "detector", "agent"],
)
def test_nothing_with_data_or_credentials_starts_before_the_preflight(service):
    depends = _compose_service(service)["depends_on"]
    assert depends["preflight"]["condition"] == "service_completed_successfully"


def _run_preflight(**values: str) -> subprocess.CompletedProcess:
    """Run the preflight service's own script, the way the container would."""
    script = _compose_service("preflight")["entrypoint"][2].replace("$$", "$")
    env = {"PATH": os.environ["PATH"], **values}
    return subprocess.run(["sh", "-c", script], capture_output=True, text=True, env=env)


_GOOD = {
    "CLICKHOUSE_PASSWORD": "a" * 64,
    "MINIO_ROOT_PASSWORD": "b" * 64,
    "ENCRYPTION_KEY": "c" * 64,
}


def test_preflight_accepts_values_the_operator_chose():
    result = _run_preflight(**_GOOD)
    assert result.returncode == 0, result.stderr


@pytest.mark.parametrize(
    "name, value",
    [
        ("CLICKHOUSE_PASSWORD", "clickhouse"),
        ("MINIO_ROOT_PASSWORD", "minio-password"),
        ("MINIO_ROOT_PASSWORD", "minio"),
        ("CLICKHOUSE_PASSWORD", "changeme"),
    ],
)
def test_preflight_refuses_a_copied_password_and_names_it(name, value):
    result = _run_preflight(**{**_GOOD, name: value})
    assert result.returncode != 0
    assert name in result.stderr
    assert value not in result.stderr.replace(name, "").replace("make prod-lite", "")


def test_preflight_refuses_the_copied_encryption_key_and_names_the_command():
    example_key = "9cf7ec27e77884f3d76dda6312f55317b2b6fff317e5b09d4a9ad7b20eff5e00"
    result = _run_preflight(**{**_GOOD, "ENCRYPTION_KEY": example_key})
    assert result.returncode != 0
    assert "ENCRYPTION_KEY" in result.stderr
    assert "make rotate-encryption-key" in result.stderr


def test_the_example_config_ships_no_encryption_key():
    assert re.search(r"^ENCRYPTION_KEY=\s*$", _ENV_EXAMPLE.read_text(), re.MULTILINE)


def test_copied_values_are_in_both_placeholder_lists():
    for value in _COPIED_VALUES:
        assert value in _makefile_list("PUBLISHED_PLACEHOLDERS")
        assert value in PUBLISHED_PLACEHOLDERS


def test_the_new_passwords_are_generated_on_the_prod_paths_only():
    from tmux_tools.launcher import PROD_GENERATED_KEYS

    for key in ("CLICKHOUSE_PASSWORD", "MINIO_ROOT_PASSWORD"):
        assert key in PROD_GENERATED_KEYS
        assert key not in GENERATED_KEYS


def test_prod_lite_replaces_a_copied_database_password(tmp_path):
    (tmp_path / ".env.example").write_text("CLICKHOUSE_PASSWORD=clickhouse  # CHANGEME\n")
    (tmp_path / ".env").write_text("CLICKHOUSE_PASSWORD=clickhouse  # CHANGEME\n")
    _run_env_secrets(tmp_path)
    generated = _values(tmp_path / ".env")["CLICKHOUSE_PASSWORD"]
    assert len(generated) == 64 and generated != "clickhouse"


# --- the encryption key is generated once and never swapped in place ----------


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


def test_the_dev_path_fills_the_encryption_key(env):
    env_path, example = env
    ensure_env_file(env_path, example)
    assert re.fullmatch(r"[0-9a-f]{64}", _values(env_path)["ENCRYPTION_KEY"])


# --- rotate-encryption-key.sh -------------------------------------------------
# The docker call is replaced by a recording stand-in here (the real run against a
# database is covered by the end-to-end check); everything else is the real script.

_ROTATE = _ROOT / "scripts" / "rotate-encryption-key.sh"
_OLD_KEY = "9cf7ec27e77884f3d76dda6312f55317b2b6fff317e5b09d4a9ad7b20eff5e00"
_STATE = ".env.encryption-key.d"


def _previous_keys(work: Path) -> list[str]:
    return [p.read_text().strip() for p in sorted((work / _STATE).glob("previous-*"))]


@pytest.fixture
def rotation(tmp_path: Path):
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    log = tmp_path / "docker.log"
    fake = bin_dir / "docker"
    fake.write_text(
        "#!/bin/sh\n"
        'echo "ARGS: $*" >> "$FAKE_DOCKER_LOG"\n'
        'case "$*" in *" stop "*) [ -n "$FAKE_DOCKER_FAIL_STOP" ] && exit 1;; esac\n'
        'case "$*" in *"run "*) echo "OLD_IS_CURRENT: $([ "$OLD_ENCRYPTION_KEY" = "$FAKE_EXPECT_OLD" ] '
        '&& echo yes || echo no)" >> "$FAKE_DOCKER_LOG"\n'
        'echo "NEW_ENV: $NEW_ENCRYPTION_KEY" >> "$FAKE_PRIVATE_LOG"\n'
        '[ -n "$FAKE_DOCKER_FAIL" ] && exit 1;; esac\n'
        "exit 0\n"
    )
    fake.chmod(0o755)
    work = tmp_path / "repo"
    work.mkdir()

    def run(fail: bool = False, fail_stop: bool = False) -> subprocess.CompletedProcess:
        env = {
            "PATH": f"{bin_dir}:{os.environ['PATH']}",
            "FAKE_DOCKER_LOG": str(log),
            "FAKE_PRIVATE_LOG": str(tmp_path / "private.log"),
            "FAKE_EXPECT_OLD": _OLD_KEY,
        }
        if fail:
            env["FAKE_DOCKER_FAIL"] = "1"
        if fail_stop:
            env["FAKE_DOCKER_FAIL_STOP"] = "1"
        return subprocess.run(
            ["sh", str(_ROTATE)], cwd=work, capture_output=True, text=True, env=env
        )

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


@pytest.mark.parametrize("target", ["prod-lite", "dev-lite"])
def test_make_targets_run_the_preflight_so_its_message_reaches_the_terminal(target):
    """Compose alone says only that preflight failed; running it prints the variable."""
    recipe = _makefile_recipe(target)
    assert "run --rm preflight" in recipe
    assert recipe.index("run --rm preflight") < recipe.index("up --build")


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
    """A planted pending key would choose the new key; a planted directory could read the old."""
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
    target = work / "attacker-readable"
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
