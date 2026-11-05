"""REST unit test configuration."""

import boto3
import pytest
from botocore.stub import Stubber


@pytest.fixture()
def service_and_stub():
    """An S3Service for ``test-bucket`` whose client is a stubbed boto3 client, so
    nothing leaves the process."""
    # Imported here: a top-level import loads settings before RATE_LIMIT_ENABLED is set.
    from rest.services.s3 import S3Service

    client = boto3.client(
        "s3",
        region_name="us-east-1",
        aws_access_key_id="test",
        aws_secret_access_key="test",
    )
    service = S3Service(bucket_name="test-bucket", access_key_id="test", secret_access_key="test")
    service._client = client
    with Stubber(client) as stub:
        yield service, stub
        stub.assert_no_pending_responses()


@pytest.fixture(autouse=True)
def _cleanup_app_overrides():
    """Clean up FastAPI dependency overrides after each test."""
    from rest.main import app

    yield
    app.dependency_overrides.clear()
