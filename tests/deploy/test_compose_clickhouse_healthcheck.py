"""ClickHouse must be reported healthy only once it accepts network connections.

On first boot its entrypoint runs a temporary server bound to 127.0.0.1, so a
localhost healthcheck passes before clickhouse-init can connect over the network.
"""

from pathlib import Path

import pytest
import yaml

_ROOT = Path(__file__).resolve().parents[2]
_COMPOSE = [_ROOT / "docker-compose.yml", _ROOT / "docker-compose.prod.yml"]


@pytest.mark.parametrize("compose_path", _COMPOSE, ids=lambda p: p.name)
def test_clickhouse_healthcheck_uses_the_network_address(compose_path):
    services = yaml.safe_load(compose_path.read_text())["services"]
    assert "http://clickhouse:8123/ping" in services["clickhouse"]["healthcheck"]["test"]
