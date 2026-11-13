"""Fixtures shared by the worker tests."""

from unittest.mock import MagicMock

import pytest


@pytest.fixture()
def mock_s3(monkeypatch):
    """Mock S3 service."""
    mock = MagicMock()
    monkeypatch.setattr("rest.services.s3.get_s3_service", lambda: mock)
    return mock
