"""Deploy-artifact guard: the MCP service must stay free of secrets.

The MCP server forwards the caller's API key to ``rest``, which validates it.
It holds no credential of its own, so it must never be given the internal API
secret or a database URL: a leaked or compromised MCP container would otherwise
reach the same internal surface as ``web`` and ``agent``.
"""

import os

import yaml

_COMPOSE_PATH = os.path.join(os.path.dirname(__file__), "..", "..", "docker-compose.prod.yml")

_FORBIDDEN = ("INTERNAL_API_SECRET", "DATABASE_URL", "ENCRYPTION_KEY", "REDIS_URL")


def _mcp_service() -> dict:
    with open(_COMPOSE_PATH) as f:
        return yaml.safe_load(f)["services"]["mcp"]


def _environment(service: dict) -> dict:
    env = service["environment"]
    if isinstance(env, list):
        return dict(item.split("=", 1) for item in env)
    return env


def test_mcp_service_receives_no_secrets():
    env = _environment(_mcp_service())
    leaked = [name for name in _FORBIDDEN if name in env]
    assert not leaked, f"mcp must not receive {leaked} in docker-compose.prod.yml"


def test_mcp_service_reaches_rest_and_listens_on_8200():
    service = _mcp_service()
    assert _environment(service)["BACKEND_INTERNAL_URL"] == "http://rest:8000"
    assert "8200:8200" in service["ports"]
    assert "rest" in service["depends_on"]
