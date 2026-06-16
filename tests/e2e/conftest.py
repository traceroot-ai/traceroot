"""Fixtures for the live-stack e2e suite.

The whole package is skipped unless ``TRACEROOT_E2E=1`` and a ``TRACEROOT_API_KEY``
is available, so it never runs in the normal unit suite (it needs the running
stack). Everything else self-configures from the repo ``.env`` (loaded by the root
``tests/conftest.py``): the internal secret, ClickHouse, Postgres, and Redis all come
from ``shared.config.settings``. The project id is derived from the API key via the
public ``whoami`` endpoint, and the detector under test is auto-discovered from
Postgres (you pre-create a 100%-sample detector in the UI).
"""

from __future__ import annotations

import os
from pathlib import Path

import httpx
import pytest
from dotenv import load_dotenv

# Load the repo .env BEFORE shared.config builds its settings singleton, so
# non-default values (notably INTERNAL_API_SECRET) are picked up. The root
# conftest's load_dotenv runs too late for this module-level import.
load_dotenv(Path(__file__).resolve().parents[2] / ".env")

from shared.config import settings  # noqa: E402
from tests.e2e.harness import DEFAULT_HOST, E2EClient, E2EConfig  # noqa: E402


def _require(reason: str):
    pytest.skip(reason, allow_module_level=False)


@pytest.fixture(scope="session")
def e2e_config() -> E2EConfig:
    """Resolve live-stack config or skip the whole suite.

    Skips (rather than fails) when the suite isn't opted into or the API key /
    internal secret aren't present, so a plain ``pytest`` run stays green.
    """
    if os.getenv("TRACEROOT_E2E") != "1":
        _require("e2e suite is opt-in: set TRACEROOT_E2E=1 with the stack running")

    api_key = os.getenv("TRACEROOT_API_KEY")
    if not api_key:
        _require("TRACEROOT_API_KEY not set (create a project API key in the UI)")

    internal_secret = settings.internal_api_secret
    if not internal_secret:
        _require("INTERNAL_API_SECRET not configured in .env")

    host = os.getenv("TRACEROOT_HOST", DEFAULT_HOST).rstrip("/")

    # Resolve the project the key maps to (mirrors how the CLI's `whoami` works),
    # so the test never hard-codes a project id.
    resp = httpx.get(
        f"{host}/api/v1/public/whoami",
        headers={"Authorization": f"Bearer {api_key}"},
        timeout=15.0,
    )
    if resp.status_code != 200:
        _require(f"whoami failed ({resp.status_code}); is the API key valid / stack up?")
    project_id = resp.json()["project_id"]

    return E2EConfig(
        host=host,
        api_key=api_key,
        internal_secret=internal_secret,
        project_id=project_id,
    )


@pytest.fixture(scope="session")
def client(e2e_config: E2EConfig):
    c = E2EClient(e2e_config)
    yield c
    c.close()


@pytest.fixture(scope="session")
def ch():
    """ClickHouse client from repo settings (CLICKHOUSE_* in .env)."""
    from db.clickhouse.client import get_clickhouse_client

    return get_clickhouse_client()


@pytest.fixture(scope="session")
def redis_client():
    import redis as redis_lib

    return redis_lib.from_url(settings.redis.url)


@pytest.fixture(scope="session")
def detector(e2e_config: E2EConfig) -> dict:
    """The enabled detector under test, read from Postgres.

    Prefers a 100%-sample detector so the deterministic sampler always fires.
    Skips with guidance if the project has no enabled detector — you create one
    in the UI first (see README).
    """
    import psycopg2

    conn = psycopg2.connect(settings.database_url)
    try:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT d.id, d.sample_rate, dt.conditions
                FROM detectors d
                LEFT JOIN detector_triggers dt ON dt.detector_id = d.id
                WHERE d.project_id = %s AND d.enabled = TRUE
                ORDER BY (d.sample_rate = 100) DESC, d.sample_rate DESC
                """,
                (e2e_config.project_id,),
            )
            row = cur.fetchone()
    finally:
        conn.close()

    if row is None:
        _require(
            "no enabled detector for this project — create a 100%-sample detector "
            "in the UI (empty trigger conditions = always triggers)"
        )

    detector_id, sample_rate, conditions = row
    if sample_rate != 100:
        # Non-100% still works for enqueue/no-early-eval checks, but the
        # exactly-one-run timing assertions rely on the trace being sampled in.
        pytest.skip(
            f"detector {detector_id} samples at {sample_rate}%, not 100%; "
            "create a 100%-sample detector for deterministic timing tests"
        )
    return {"id": detector_id, "sample_rate": sample_rate, "conditions": conditions}
