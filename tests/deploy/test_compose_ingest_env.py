"""The ingest limits can be set on the prod compose stack, the same for the API and worker.

docker-compose.prod.yml passes a container only the variables it lists, so a limit
left out there keeps its default whatever .env says. Each byte limit is passed to
both ``rest`` and ``worker`` from the same .env value, so the two can never disagree.
The budgets on what a batch decodes into are passed to ``worker``, which checks them, and
so is the limit on redelivering a batch whose worker process died.
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
BUDGETS = {
    "INGEST_MAX_SPANS": "max_spans",
    "INGEST_MAX_OBJECTS": "max_objects",
    "INGEST_MAX_DELIVERIES": "max_deliveries",
}


def _default(name: str) -> int:
    return IngestSettings.model_fields[{**LIMITS, **BUDGETS}[name]].default


def _environment(service: str) -> dict:
    compose = yaml.safe_load((ROOT / "docker-compose.prod.yml").read_text())
    return compose["services"][service]["environment"]


@pytest.mark.parametrize("service", ["rest", "worker"])
@pytest.mark.parametrize("name", sorted(LIMITS))
def test_prod_compose_passes_the_limit_with_the_code_default(service, name):
    assert _environment(service)[name] == f"${{{name}:-{_default(name)}}}"


@pytest.mark.parametrize("name", sorted(BUDGETS))
def test_prod_compose_passes_the_budget_to_the_worker_with_the_code_default(name):
    assert _environment("worker")[name] == f"${{{name}:-{_default(name)}}}"


@pytest.mark.parametrize("name", sorted({**LIMITS, **BUDGETS}))
def test_env_example_lists_the_limit_with_the_code_default(name):
    assert f"\n# {name}={_default(name)}\n" in (ROOT / ".env.example").read_text()
