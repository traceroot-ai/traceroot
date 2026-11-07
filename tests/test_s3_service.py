"""Offline S3 bucket bootstrap checks using botocore's request validator."""

from contextlib import closing

import boto3
import pytest
from botocore.exceptions import ClientError
from botocore.stub import Stubber

from rest.services.s3 import S3Service


@pytest.fixture
def s3_client(monkeypatch):
    monkeypatch.delenv("AWS_PROFILE", raising=False)
    monkeypatch.delenv("AWS_DEFAULT_PROFILE", raising=False)
    with closing(
        boto3.client(
            "s3",
            endpoint_url="https://s3.example.test",
            aws_access_key_id="testing",
            aws_secret_access_key="testing",
            region_name="us-east-1",
        )
    ) as client:
        monkeypatch.setattr("rest.services.s3.boto3.client", lambda *args, **kwargs: client)
        yield client


@pytest.mark.parametrize("region", ["us-west-2", "eu-west-1"])
def test_missing_bucket_is_created_in_configured_region(s3_client, region):
    service = S3Service(bucket_name="trace-test-bucket", region=region)
    with Stubber(s3_client) as stub:
        stub.add_client_error(
            "head_bucket",
            service_error_code="404",
            http_status_code=404,
            expected_params={"Bucket": "trace-test-bucket"},
        )
        stub.add_response(
            "create_bucket",
            {},
            {
                "Bucket": "trace-test-bucket",
                "CreateBucketConfiguration": {"LocationConstraint": region},
            },
        )
        service.ensure_bucket_exists()
        stub.assert_no_pending_responses()


@pytest.mark.parametrize("endpoint", [None, "http://minio.example.test:9000"])
def test_us_east_1_keeps_default_creation_request(s3_client, endpoint):
    service = S3Service(endpoint_url=endpoint, bucket_name="trace-test-bucket", region="us-east-1")
    with Stubber(s3_client) as stub:
        stub.add_client_error(
            "head_bucket",
            service_error_code="404",
            http_status_code=404,
            expected_params={"Bucket": "trace-test-bucket"},
        )
        stub.add_response("create_bucket", {}, {"Bucket": "trace-test-bucket"})
        service.ensure_bucket_exists()
        stub.assert_no_pending_responses()


def test_existing_bucket_is_not_created(s3_client):
    service = S3Service(bucket_name="trace-test-bucket", region="eu-west-1")
    with Stubber(s3_client) as stub:
        stub.add_response("head_bucket", {}, {"Bucket": "trace-test-bucket"})
        service.ensure_bucket_exists()
        stub.assert_no_pending_responses()


def test_permission_error_does_not_create_bucket(s3_client):
    service = S3Service(bucket_name="trace-test-bucket", region="eu-west-1")
    with Stubber(s3_client) as stub:
        stub.add_client_error(
            "head_bucket",
            service_error_code="403",
            http_status_code=403,
            expected_params={"Bucket": "trace-test-bucket"},
        )
        with pytest.raises(ClientError) as error:
            service.ensure_bucket_exists()
        assert error.value.response["Error"]["Code"] == "403"
        stub.assert_no_pending_responses()
