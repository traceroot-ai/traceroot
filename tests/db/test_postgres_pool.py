"""The ingestion connection pool is initialized only once per process."""

from concurrent.futures import ThreadPoolExecutor
from threading import Barrier, Event
from unittest.mock import MagicMock

from db import postgres
from shared.config import settings


def test_concurrent_callers_share_one_lazy_pool(monkeypatch):
    callers = Barrier(8)
    pool = object()

    def make_pool(*args, **kwargs):
        # Model slow connection setup so competing callers reach initialization.
        Event().wait(0.1)
        return pool

    def get_pool(_):
        callers.wait(timeout=5)
        return postgres.get_pg_pool()

    factory = MagicMock(side_effect=make_pool)
    monkeypatch.setattr(postgres, "_pool", None)
    monkeypatch.setattr(postgres, "ThreadedConnectionPool", factory)
    with ThreadPoolExecutor(max_workers=8) as executor:
        pools = list(executor.map(get_pool, range(8)))
    factory.assert_called_once_with(1, 8, settings.database_url, connect_timeout=5)
    assert all(result is pool for result in pools)
