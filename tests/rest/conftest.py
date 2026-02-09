"""REST unit test configuration."""

import pytest


@pytest.fixture(autouse=True)
def _cleanup_app_overrides():
    """Clean up FastAPI dependency overrides after each test."""
    from rest.main import app

    yield
    app.dependency_overrides.clear()
