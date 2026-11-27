"""The prod compose worker can reach the web app, as the API service does.

The ingest worker reports to the web app that a project received traces
(worker/trace_activity.py). docker-compose.prod.yml passes a container only the
variables it lists, so the worker lists the web app's internal address and the
shared internal secret, with the values the API service gets.
"""

from pathlib import Path

import pytest
import yaml

ROOT = Path(__file__).resolve().parents[2]


def _environment(service: str) -> dict:
    compose = yaml.safe_load((ROOT / "docker-compose.prod.yml").read_text())
    return compose["services"][service]["environment"]


@pytest.mark.parametrize("name", ["TRACEROOT_UI_URL", "INTERNAL_API_SECRET"])
def test_worker_gets_the_web_app_settings_the_api_gets(name):
    assert _environment("worker")[name] == _environment("rest")[name]


def test_worker_reaches_the_web_app_on_the_compose_network():
    assert _environment("worker")["TRACEROOT_UI_URL"] == "http://web:3000"
