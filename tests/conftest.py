"""Root test configuration."""

import os
from pathlib import Path

import pytest
from dotenv import load_dotenv


def pytest_configure(config):
    """Load env vars from root .env and neutralize the global app limiter.

    The module-level app limiter must be inert for the existing router tests:
    otherwise they share one ``rl:read:free`` bucket and 429 once the suite
    exceeds the free read limit. We default ``RATE_LIMIT_ENABLED=false`` only as
    a last resort, AFTER ``load_dotenv`` runs, so that an explicit override from
    either the real environment or ``.env`` wins (load order matters:
    ``setdefault`` before ``load_dotenv`` would silently mask a ``.env`` value
    because ``load_dotenv`` does not override an already-set key). The
    enforcement tests in ``test_rate_limit`` build their own enabled limiter, so
    they are unaffected.
    """
    env_file = Path(__file__).parent.parent / ".env"
    if env_file.exists():
        load_dotenv(env_file)
    os.environ.setdefault("RATE_LIMIT_ENABLED", "false")


@pytest.fixture(autouse=True)
def _reset_singletons(monkeypatch):
    """Reset module-level singleton instances between tests.

    Prevents test pollution from cached ClickHouse/S3 clients.
    """
    import db.clickhouse.client as ch_mod
    import rest.services.s3 as s3_mod
    import rest.services.trace_reader as tr_mod

    monkeypatch.setattr(ch_mod, "_client", None)
    monkeypatch.setattr(ch_mod, "_ro_client", None)
    monkeypatch.setattr(s3_mod, "_s3_service", None)
    monkeypatch.setattr(tr_mod, "_service", None)
