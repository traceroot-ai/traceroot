"""S3 bucket bootstrap requests must use the configured storage region."""

from contextlib import closing

import pytest
from botocore.exceptions import ClientError
from botocore.stub import Stubber

from rest.services.s3 import S3Service
from shared.config import settings

BUCKET = "traceroot-test-bucket"


def make_service(monkeypatch, region, endpoint):
    # Keep local .env settings and ambient AWS credentials out of these tests.
    monkeypatch.setattr(settings.s3, "endpoint_url", endpoint)
    return S3Service(
        access_key_id="test-access-key",
        secret_access_key="test-secret-key",
        bucket_name=BUCKET,
        region=region,
    )


@pytest.mark.parametrize("region", ["us-east-1", "eu-west-1", "ap-south-1"])
@pytest.mark.parametrize("endpoint", [None, "http://minio:9000"])
def test_create_missing_bucket_in_configured_region(monkeypatch, region, endpoint):
    service = make_service(monkeypatch, region, endpoint)
    create_params = {"Bucket": BUCKET}
    if region != "us-east-1":
        create_params["CreateBucketConfiguration"] = {"LocationConstraint": region}

    with closing(service._get_client()) as client, Stubber(client) as stub:
        if endpoint is not None:
            assert client.meta.endpoint_url == endpoint
        stub.add_client_error(
            "head_bucket",
            service_error_code="404",
            http_status_code=404,
            expected_params={"Bucket": BUCKET},
        )
        stub.add_response("create_bucket", {}, expected_params=create_params)

        service.ensure_bucket_exists()

        stub.assert_no_pending_responses()


@pytest.mark.parametrize("endpoint", [None, "http://minio:9000"])
def test_existing_bucket_is_not_recreated(monkeypatch, endpoint):
    service = make_service(monkeypatch, "eu-west-1", endpoint)
    with closing(service._get_client()) as client, Stubber(client) as stub:
        stub.add_response("head_bucket", {}, expected_params={"Bucket": BUCKET})

        service.ensure_bucket_exists()

        stub.assert_no_pending_responses()


def test_head_permission_error_is_not_treated_as_missing_bucket(monkeypatch):
    service = make_service(monkeypatch, "eu-west-1", None)
    with closing(service._get_client()) as client, Stubber(client) as stub:
        stub.add_client_error(
            "head_bucket",
            service_error_code="403",
            http_status_code=403,
            expected_params={"Bucket": BUCKET},
        )

        with pytest.raises(ClientError) as error:
            service.ensure_bucket_exists()

        assert error.value.operation_name == "HeadBucket"
        assert error.value.response["Error"]["Code"] == "403"
        stub.assert_no_pending_responses()


def test_create_permission_error_is_propagated(monkeypatch):
    service = make_service(monkeypatch, "eu-west-1", None)
    with closing(service._get_client()) as client, Stubber(client) as stub:
        stub.add_client_error(
            "head_bucket",
            service_error_code="404",
            http_status_code=404,
            expected_params={"Bucket": BUCKET},
        )
        stub.add_client_error(
            "create_bucket",
            service_error_code="AccessDenied",
            http_status_code=403,
            expected_params={
                "Bucket": BUCKET,
                "CreateBucketConfiguration": {"LocationConstraint": "eu-west-1"},
            },
        )

        with pytest.raises(ClientError) as error:
            service.ensure_bucket_exists()

        assert error.value.operation_name == "CreateBucket"
        assert error.value.response["Error"]["Code"] == "AccessDenied"
        stub.assert_no_pending_responses()
