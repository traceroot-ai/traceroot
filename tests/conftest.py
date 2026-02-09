"""Root test configuration."""

from pathlib import Path

import pytest
from dotenv import load_dotenv


def pytest_configure(config):
    """Load env vars from root .env."""
    env_file = Path(__file__).parent.parent / ".env"
    if env_file.exists():
        load_dotenv(env_file)


@pytest.fixture(autouse=True)
def _reset_singletons(monkeypatch):
    """Reset module-level singleton instances between tests.

    Prevents test pollution from cached ClickHouse/S3 clients.
    """
    import db.clickhouse.client as ch_mod
    import rest.services.s3 as s3_mod
    import rest.services.trace_reader as tr_mod

    monkeypatch.setattr(ch_mod, "_client", None)
    monkeypatch.setattr(s3_mod, "_s3_service", None)
    monkeypatch.setattr(tr_mod, "_service", None)
