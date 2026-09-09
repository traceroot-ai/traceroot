"""Guards on the compose bootstrap artifacts.

These are mounted into ClickHouse at startup, so a malformed one does not fail a
test or a lint -- the server refuses to boot and the whole stack is down. Nothing
else in CI reads them: `docker compose config` validates the YAML around them, not
the XML inside them, which is how an invalid comment shipped once.
"""

import re
import xml.etree.ElementTree as ET
from pathlib import Path

import pytest
import yaml

_ROOT = Path(__file__).resolve().parents[2]
_BOOTSTRAP = _ROOT / "backend" / "db" / "clickhouse" / "bootstrap"
_XML = _BOOTSTRAP / "sql_gateway_bootstrap_user.xml"
_COMPOSE = [_ROOT / "docker-compose.yml", _ROOT / "docker-compose.prod.yml"]


def test_bootstrap_xml_is_well_formed():
    """A SAXParseException here is an exit-232 server, not a failing test."""
    ET.parse(_XML)


def test_bootstrap_xml_comments_have_no_double_hyphen():
    """XML forbids `--` inside a comment. An em dash or an underline rule is the
    easy way to write one by accident, and it takes the server down."""
    for comment in re.findall(r"<!--(.*?)-->", _XML.read_text(), re.DOTALL):
        assert "--" not in comment, "double hyphen inside an XML comment"


def test_only_the_bootstrap_account_holds_access_management():
    """The privilege must not land on the account the application runs as."""
    root = ET.parse(_XML).getroot()
    holders = [
        user.tag for user in root.find("users") if user.find("access_management") is not None
    ]
    assert holders == ["sql_gateway_bootstrap"], (
        f"access_management is granted to {holders}; it belongs only to the bootstrap identity"
    )


def test_password_is_not_written_into_the_file():
    """It comes from the environment, so the mounted config carries no secret."""
    root = ET.parse(_XML).getroot()
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
