"""Fixtures shared by the worker tests."""

from unittest.mock import MagicMock

import pytest


@pytest.fixture(autouse=True)
def mock_project_ingestion(monkeypatch):
    """Keep project activity writes isolated from Postgres in worker unit tests."""
    mock = MagicMock()
    monkeypatch.setattr("worker.ingest_tasks.record_project_ingestion", mock)
    return mock


@pytest.fixture()
def mock_s3(monkeypatch):
    """Mock S3 service."""
    mock = MagicMock()
    monkeypatch.setattr("rest.services.s3.get_s3_service", lambda: mock)
    return mock
