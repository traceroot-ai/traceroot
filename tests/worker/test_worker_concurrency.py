"""The Celery worker runs a pinned number of processes, not one per host CPU."""

import os
import subprocess
import sys
from pathlib import Path

import pytest
import yaml

from shared.config import WorkerSettings, settings
from worker.celery_app import app

ROOT = Path(__file__).resolve().parents[2]


class TestWorkerSettings:
    def test_default_is_two(self, monkeypatch):
        monkeypatch.delenv("WORKER_CONCURRENCY", raising=False)
        assert WorkerSettings().concurrency == 2

    def test_env_override(self, monkeypatch):
        monkeypatch.setenv("WORKER_CONCURRENCY", "4")
        assert WorkerSettings().concurrency == 4

    @pytest.mark.parametrize("value", ["0", "-1", "two", "1.5"])
    def test_invalid_values_are_rejected(self, monkeypatch, value):
        monkeypatch.setenv("WORKER_CONCURRENCY", value)
        with pytest.raises(ValueError):
            WorkerSettings()


def test_celery_app_uses_the_setting():
    assert app.conf.worker_concurrency == settings.worker.concurrency


def test_env_override_reaches_the_celery_app():
    """A worker started with WORKER_CONCURRENCY hands that to Celery as its process count."""
    env = {k: v for k, v in os.environ.items() if k != "WORKER_CONCURRENCY"}
    env.update(
        WORKER_CONCURRENCY="3",
        TRACEROOT_ENABLED="false",
        PYTHONPATH=f"{ROOT}:{ROOT / 'backend'}",
    )
    result = subprocess.run(
        [
            sys.executable,
            "-c",
            "from worker.celery_app import app; print(app.conf.worker_concurrency)",
        ],
        cwd=ROOT / "backend",
        env=env,
        capture_output=True,
        text=True,
        timeout=60,
    )

    assert result.returncode == 0, result.stderr
    assert result.stdout.strip().splitlines()[-1] == "3"


def test_prod_compose_passes_the_setting_to_the_worker():
    compose = yaml.safe_load((ROOT / "docker-compose.prod.yml").read_text())
    env = compose["services"]["worker"]["environment"]
    assert env["WORKER_CONCURRENCY"] == "${WORKER_CONCURRENCY:-2}"


def test_env_example_documents_the_default():
    assert "\nWORKER_CONCURRENCY=2\n" in (ROOT / ".env.example").read_text()
