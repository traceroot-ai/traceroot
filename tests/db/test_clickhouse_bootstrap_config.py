"""Guards on the compose bootstrap artifacts.

These are mounted into ClickHouse at startup, so a malformed one does not fail a
test or a lint -- the server refuses to boot and the whole stack is down. Nothing
else in CI reads them: `docker compose config` validates the YAML around them, not
the XML inside them, which is how an invalid comment shipped once.
"""

import hashlib
import os
import re
import shlex
import shutil
import subprocess
from pathlib import Path
from urllib.parse import unquote_to_bytes

import pytest
import yaml

# defusedxml rather than the stdlib xml modules: those are XXE-prone and scanners reject them.
from defusedxml.ElementTree import parse as parse_xml

_ROOT = Path(__file__).resolve().parents[2]
_BOOTSTRAP = _ROOT / "backend" / "db" / "clickhouse" / "bootstrap"
_XML = _BOOTSTRAP / "sql_gateway_bootstrap_user.xml"
_COMPOSE = [_ROOT / "docker-compose.yml", _ROOT / "docker-compose.prod.yml"]


def test_bootstrap_xml_is_well_formed():
    """A SAXParseException here is an exit-232 server, not a failing test."""
    parse_xml(_XML)


def test_bootstrap_xml_comments_have_no_double_hyphen():
    """XML forbids `--` inside a comment. An em dash or an underline rule is the
    easy way to write one by accident, and it takes the server down."""
    for comment in re.findall(r"<!--(.*?)-->", _XML.read_text(), re.DOTALL):
        assert "--" not in comment, "double hyphen inside an XML comment"


def test_only_the_bootstrap_account_holds_access_management():
    """The privilege must not land on the account the application runs as."""
    root = parse_xml(_XML).getroot()
    holders = [
        user.tag for user in root.find("users") if user.find("access_management") is not None
    ]
    assert holders == ["sql_gateway_bootstrap"], (
        f"access_management is granted to {holders}; it belongs only to the bootstrap identity"
    )


def test_password_is_not_written_into_the_file():
    """It comes from the environment, so the mounted config carries no secret."""
    root = parse_xml(_XML).getroot()
    pw = root.find("users").find("sql_gateway_bootstrap").find("password")
    assert pw.get("from_env"), "password must use from_env"
    assert not (pw.text or "").strip(), "password literal present in the mounted config"


@pytest.mark.parametrize("path", _COMPOSE, ids=lambda p: p.name)
def test_application_services_do_not_use_the_bootstrap_identity(path):
    """rest/worker/billing/detector authenticate as CLICKHOUSE_USER; only the
    one-shot provisioning and migration containers may be the bootstrap account."""
    services = (yaml.safe_load(path.read_text()) or {}).get("services") or {}
    allowed = {"clickhouse-init", "migrate-clickhouse"}
    for name, svc in services.items():
        env = svc.get("environment") or {}
        items = (
            env
            if isinstance(env, dict)
            else dict(e.split("=", 1) for e in env if isinstance(e, str) and "=" in e)
        )
        if items.get("CLICKHOUSE_USER") == "sql_gateway_bootstrap":
            assert name in allowed, f"{name} must not run as the bootstrap identity"


def test_rest_receives_the_readonly_identity():
    """Provisioning the account is not the same as the API being able to use it.

    `clickhouse-init` creates `sql_gateway_ro`, but the API authenticates as whoever
    `CLICKHOUSE_RO_USER` names. Without the pair on the `rest` service, setting them in
    `.env` reaches nothing, and a billing-enabled deployment raises instead of serving
    gateway queries.
    """
    prod = next(p for p in _COMPOSE if p.name == "docker-compose.prod.yml")
    rest_env = yaml.safe_load(prod.read_text())["services"]["rest"]["environment"]
    for key in ("CLICKHOUSE_RO_USER", "CLICKHOUSE_RO_PASSWORD"):
        assert key in rest_env, f"rest cannot authenticate as the gateway reader without {key}"

    # The account name is fixed by the bootstrap script, so the default has to match it.
    # An empty default reads as unset, which silently disables the read-only client.
    created = (_BOOTSTRAP / "sql_gateway_readonly.sql").read_text()
    name = re.search(r"CREATE USER IF NOT EXISTS (sql_gateway_ro)\b", created)
    assert name, "could not find the read-only account in the bootstrap script"

    # Compare the parsed default for equality, not containment. A longer name that merely
    # embeds the right one, `not_sql_gateway_ro_extra`, is a different account and is
    # exactly the substitution this exists to catch.
    template = rest_env["CLICKHOUSE_RO_USER"]
    default = re.fullmatch(r"\$\{CLICKHOUSE_RO_USER:-([^}]*)\}", template)
    assert default, (
        f"rest sets CLICKHOUSE_RO_USER to {template!r}; expected a "
        "${CLICKHOUSE_RO_USER:-<account>} form so the default can be checked"
    )
    assert default.group(1) == name.group(1), (
        f"rest defaults CLICKHOUSE_RO_USER to {default.group(1)!r}, but the bootstrap script "
        f"creates {name.group(1)!r}"
    )


def _service_entrypoint_text(compose_path: Path, service: str) -> str:
    """The entrypoint as one string, whether compose spells it as a scalar or a list."""
    spec = yaml.safe_load(compose_path.read_text())["services"][service]["entrypoint"]
    return spec if isinstance(spec, str) else "\n".join(spec)


@pytest.mark.parametrize("compose_path", _COMPOSE, ids=lambda p: p.name)
def test_migration_dsn_encoder_survives_repeated_password_blocks(compose_path):
    """`od` collapses repeated 16-byte lines to `*` unless `-v` is given.

    The `*` lands inside the hex string, so the percent-encoded password in the DSN is
    silently wrong and the migration fails to authenticate. Rather than grep for the
    flag, this runs the encoder exactly as compose spells it against a password made of
    two identical 16-byte blocks, and requires the result to decode back.
    """
    entrypoint = _service_entrypoint_text(compose_path, "migrate-clickhouse")
    match = re.search(r"\|\s*(od [^|]*?)\s*\|", entrypoint)
    assert match, f"no `od` stage found in the migrate DSN builder:\n{entrypoint}"
    od_flags = match.group(1).split()[1:]

    password = "abcdefghijklmnop" * 2
    hex_out = subprocess.run(
        ["od", *od_flags], input=password.encode(), capture_output=True, check=True
    ).stdout.decode()
    hex_digits = "".join(hex_out.split())
    encoded = "".join(f"%{hex_digits[i : i + 2]}" for i in range(0, len(hex_digits), 2))

    assert unquote_to_bytes(encoded) == password.encode(), (
        f"{compose_path.name}: `od {' '.join(od_flags)}` mangles a password with repeated "
        f"16-byte blocks -> {encoded!r}. Add -v to disable duplicate-line compression."
    )


@pytest.mark.parametrize("compose_path", _COMPOSE, ids=lambda p: p.name)
def test_database_name_is_validated_before_substitution(compose_path):
    """CLICKHOUSE_DATABASE is pasted into GRANT statements via sed.

    A name that needs identifier quoting makes the grants invalid SQL, and a name
    containing a sed metacharacter rewrites the generated script. The guard has to run
    before the substitution, so its position is asserted, not just its presence.
    """
    entrypoint = _service_entrypoint_text(compose_path, "clickhouse-init")
    guard = entrypoint.find('CLICKHOUSE_DATABASE\\" in')
    substitution = entrypoint.find("s/__DB__/")

    assert substitution != -1, "clickhouse-init no longer substitutes __DB__"
    assert guard != -1, (
        "clickhouse-init substitutes CLICKHOUSE_DATABASE into SQL without validating it"
    )
    assert guard < substitution, "the database-name guard must run before the sed"


def test_gateway_passwords_do_not_stop_the_stack_from_loading():
    """`:?` fails when compose READS the file, so a required gateway password stopped
    `docker compose config` and every unrelated service for self-hosters who never use
    the gateway. Neither gateway password may be required at load time.

    The bootstrap password is the exception, and deliberately: migrate-clickhouse
    authenticates as that account, so every stack needs it, gateway or not.
    """
    prod = next(p for p in _COMPOSE if p.name == "docker-compose.prod.yml")
    services = yaml.safe_load(prod.read_text())["services"]
    for name, spec in services.items():
        env = spec.get("environment") or {}
        for key in ("SQL_GATEWAY_WRITER_PASSWORD", "CLICKHOUSE_RO_PASSWORD"):
            if key in env:
                assert ":?" not in str(env[key]), f"{name} requires {key} at config load"
    for name in ("clickhouse", "migrate-clickhouse"):
        env = services[name]["environment"]
        assert ":?" in str(env["SQL_GATEWAY_BOOTSTRAP_PASSWORD"]), (
            f"{name} must still require the bootstrap password; migrations run as it"
        )


def _run_init(compose_path: Path, tmp_path: Path, writer: str, readonly: str) -> dict:
    """Run clickhouse-init's entrypoint as compose would, against a stub client.

    Compose unescapes `$$` and splits the entrypoint string into argv; this does the
    same, then points the container paths at a temporary directory. The stub records
    every queries file it is handed, so the test sees exactly the SQL that would reach
    ClickHouse.
    """
    spec = yaml.safe_load(compose_path.read_text())["services"]["clickhouse-init"]
    mounted = {v.split(":")[1] for v in spec["volumes"]}
    argv = shlex.split(spec["entrypoint"].replace("$$", "$"))
    assert argv[:2] == ["/bin/sh", "-c"], argv[:2]

    bootstrap, work, bin_dir, calls = (tmp_path / d for d in ("bootstrap", "tmp", "bin", "calls"))
    for d in (bootstrap, work, bin_dir, calls):
        d.mkdir(parents=True)
    for container_path in mounted:
        shutil.copy(_BOOTSTRAP / Path(container_path).name, bootstrap)
    # Anchored on the preceding whitespace: the temporary directory itself usually lives
    # under /tmp, so a plain replace would rewrite the paths it had just substituted.
    script = re.sub(r"(?<=\s)/bootstrap/", f"{bootstrap}/", argv[2])
    script = re.sub(r"(?<=\s)/tmp/", f"{work}/", script)

    stub = bin_dir / "clickhouse-client"
    stub.write_text(
        "#!/bin/sh\n"
        'while [ $# -gt 0 ]; do [ "$1" = --queries-file ] && cp "$2" "$CALLS/$(basename "$2")"; shift; done\n'
    )
    stub.chmod(0o755)
    if shutil.which("sha256sum") is None and shutil.which("shasum"):
        shim = bin_dir / "sha256sum"
        shim.write_text('#!/bin/sh\nexec shasum -a 256 "$@"\n')
        shim.chmod(0o755)

    env = {
        "PATH": f"{bin_dir}{os.pathsep}{os.environ['PATH']}",
        "CALLS": str(calls),
        "CLICKHOUSE_USER": "sql_gateway_bootstrap",
        "CLICKHOUSE_DATABASE": "default",
        "SQL_GATEWAY_WRITER_PASSWORD": writer,
        "CLICKHOUSE_RO_PASSWORD": readonly,
    }
    out = subprocess.run(["sh", "-c", script], env=env, capture_output=True, text=True)
    assert out.returncode == 0, out.stderr
    return {"stdout": out.stdout, **{f.name: f.read_text() for f in calls.iterdir()}}


def _hash(sql: str, user: str) -> str:
    match = re.search(
        rf"CREATE USER IF NOT EXISTS {user}\s+IDENTIFIED WITH sha256_hash BY '([^']*)'", sql
    )
    assert match, f"{user} is not created in:\n{sql}"
    return match.group(1)


_EMPTY_SHA256 = hashlib.sha256(b"").hexdigest()


@pytest.mark.parametrize("compose_path", _COMPOSE, ids=lambda p: p.name)
def test_unset_writer_password_is_generated_not_empty(compose_path, tmp_path):
    """The writer must exist for migration 012 and must never be passwordless. Hashing
    an unset variable would give the SHA-256 of the empty string, which is a password
    anyone can supply."""
    run = _run_init(compose_path, tmp_path, writer="", readonly="")
    first, second = _hash(run["sql_gateway_users.sql"], "sql_gateway_writer"), None
    assert re.fullmatch(r"[0-9a-f]{64}", first)
    assert first != _EMPTY_SHA256, "the writer was created with an empty password"

    second = _hash(
        _run_init(compose_path, tmp_path / "again", "", "")["sql_gateway_users.sql"],
        "sql_gateway_writer",
    )
    assert first != second, "the generated writer password is not random"


@pytest.mark.parametrize("compose_path", _COMPOSE, ids=lambda p: p.name)
def test_readonly_account_is_provisioned_only_with_its_password(compose_path, tmp_path):
    """No password means the gateway is not in use, so the account is not created, rather
    than created with a password nobody chose."""
    off = _run_init(compose_path, tmp_path / "off", writer="w", readonly="")
    assert "sql_gateway_readonly.sql" not in off, "the read-only account was provisioned"
    assert "not provisioned" in off["stdout"]

    on = _run_init(compose_path, tmp_path / "on", writer="w", readonly="r0-pass")
    assert (
        _hash(on["sql_gateway_readonly.sql"], "sql_gateway_ro")
        == hashlib.sha256(b"r0-pass").hexdigest()
    )
    assert (
        _hash(on["sql_gateway_users.sql"], "sql_gateway_writer") == hashlib.sha256(b"w").hexdigest()
    )
