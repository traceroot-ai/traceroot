"""Test utilities for Traceroot SDK tests."""

from uuid import uuid4


def create_uuid() -> str:
    """Create a unique identifier for tests."""
    return str(uuid4())


def reset_traceroot() -> None:
    """Reset Traceroot global state between tests."""
    import traceroot

    if traceroot.get_client():
        traceroot.shutdown()
    traceroot._client = None
