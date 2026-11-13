"""The ingestion connection pool is initialized only once per process."""

from concurrent.futures import ThreadPoolExecutor
from unittest.mock import MagicMock

from db import postgres
from shared.config import settings


def test_concurrent_callers_share_one_lazy_pool(monkeypatch):
    factory = MagicMock()
    monkeypatch.setattr(postgres, "_pool", None)
    monkeypatch.setattr(postgres, "ThreadedConnectionPool", factory)
    with ThreadPoolExecutor(max_workers=8) as executor:
        pools = list(executor.map(lambda _: postgres.get_pg_pool(), range(8)))
    factory.assert_called_once_with(1, 8, settings.database_url)
    assert all(pool is factory.return_value for pool in pools)
