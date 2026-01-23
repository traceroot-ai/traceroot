"""Core SDK tests - initialization, singleton, shutdown."""

import traceroot
from tests.utils import reset_traceroot


def test_initialize_returns_client():
    """Test initialize() returns a client instance."""
    reset_traceroot()
    client = traceroot.initialize(api_key="test-key", enabled=False)

    assert client is not None
    assert traceroot.get_client() is client


def test_disabled_without_api_key():
    """Test client is disabled when no API key provided."""
    reset_traceroot()
    client = traceroot.initialize()

    assert client.enabled is False


def test_singleton_replacement():
    """Test re-initializing replaces the singleton."""
    reset_traceroot()

    client1 = traceroot.initialize(api_key="key1", enabled=False)
    client2 = traceroot.initialize(api_key="key2", enabled=False)

    assert traceroot.get_client() is client2
    assert traceroot.get_client() is not client1


def test_shutdown():
    """Test shutdown() marks client as not initialized."""
    reset_traceroot()

    traceroot.initialize(api_key="test-key", enabled=False)
    traceroot.shutdown()

    assert traceroot.get_client()._initialized is False
