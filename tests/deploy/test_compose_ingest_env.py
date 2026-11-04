"""The ingest limits can be set on the prod compose stack, the same for the API and worker.

docker-compose.prod.yml passes a container only the variables it lists, so a limit
left out there keeps its default whatever .env says. Each limit is passed to both
``rest`` and ``worker`` from the same .env value, so the two can never disagree.
"""

from pathlib import Path

import pytest
import yaml

from shared.config import IngestSettings

ROOT = Path(__file__).resolve().parents[2]

LIMITS = {
    "INGEST_MAX_REQUEST_BYTES": "max_request_bytes",
    "INGEST_MAX_UNZIPPED_BYTES": "max_unzipped_bytes",
}


def _default(name: str) -> int:
    return IngestSettings.model_fields[LIMITS[name]].default


@pytest.mark.parametrize("service", ["rest", "worker"])
@pytest.mark.parametrize("name", sorted(LIMITS))
def test_prod_compose_passes_the_limit_with_the_code_default(service, name):
    compose = yaml.safe_load((ROOT / "docker-compose.prod.yml").read_text())
    env = compose["services"][service]["environment"]
    assert env[name] == f"${{{name}:-{_default(name)}}}"


@pytest.mark.parametrize("name", sorted(LIMITS))
def test_env_example_lists_the_limit_with_the_code_default(name):
    assert f"\n# {name}={_default(name)}\n" in (ROOT / ".env.example").read_text()
