"""Exercise Celery's broker/backend configuration without contacting Redis."""

import runpy
import ssl
from functools import partial
from pathlib import Path

import celery
import pytest
from redis import Connection, SSLConnection

from shared.config import settings


@pytest.mark.parametrize("broker_scheme", ["redis", "rediss"])
@pytest.mark.parametrize("backend_scheme", ["redis", "rediss"])
def test_redis_tls_follows_each_connections_own_url(monkeypatch, broker_scheme, backend_scheme):
    monkeypatch.setattr(settings.redis, "url", f"{broker_scheme}://localhost:6379/0")
    monkeypatch.setattr(settings.redis, "result_url", f"{backend_scheme}://localhost:6379/1")
    # Execute the production configuration afresh without replacing the app used
    # by other tests. The factory still constructs a real Celery application.
    monkeypatch.setattr(celery, "Celery", partial(celery.Celery, set_as_current=False))
    namespace = runpy.run_path(
        str(Path(__file__).resolve().parents[2] / "backend/worker/celery_app.py")
    )
    app = namespace["app"]
    try:
        # Construct the actual result backend: mixed schemes used to raise here,
        # before any connection attempt, regardless of whether Redis was healthy.
        backend = app.backend
        with app.connection_for_write() as broker:
            expected = {"ssl_cert_reqs": ssl.CERT_REQUIRED} if broker_scheme == "rediss" else None
            assert broker.ssl == expected

        connection = backend.client.connection_pool.make_connection()
        if backend_scheme == "rediss":
            assert isinstance(connection, SSLConnection)
            assert connection.cert_reqs == ssl.CERT_REQUIRED
        else:
            assert isinstance(connection, Connection)
            assert not isinstance(connection, SSLConnection)
    finally:
        app.close()
