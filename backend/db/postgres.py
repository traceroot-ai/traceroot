"""Process-local Postgres connections shared by ingestion work."""

import threading

from psycopg2.pool import ThreadedConnectionPool

_pool: ThreadedConnectionPool | None = None
_pool_lock = threading.Lock()


def get_pg_pool() -> ThreadedConnectionPool:
    """Reuse a lazily initialized connection pool within this process.

    Returns:
        ThreadedConnectionPool: The process's Postgres connection pool.
    """
    global _pool
    if _pool is None:
        with _pool_lock:
            if _pool is None:
                from shared.config import settings

                _pool = ThreadedConnectionPool(1, 8, settings.database_url)
    return _pool
