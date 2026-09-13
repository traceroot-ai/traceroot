"""Guards on the compose bootstrap artifacts.

These are mounted into ClickHouse at startup, so a malformed one does not fail a
test or a lint -- the server refuses to boot and the whole stack is down. Nothing
else in CI reads them: `docker compose config` validates the YAML around them, not
the XML inside them, which is how an invalid comment shipped once.
"""

import re
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
    created = (_BOOTSTRAP / "sql_gateway_users.sql").read_text()
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
