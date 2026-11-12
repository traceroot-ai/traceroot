"""S3Service.copy_object / delete_object against a stubbed boto3 client (no network)."""

import pytest
from botocore.exceptions import ClientError
from botocore.stub import Stubber

from rest.services.s3 import S3Service

BUCKET = "traceroot-test"


@pytest.fixture()
def service_and_stub():
    service = S3Service(
        endpoint_url="http://127.0.0.1:9",
        access_key_id="test",
        secret_access_key="test",
        bucket_name=BUCKET,
        region="us-east-1",
    )
    stub = Stubber(service._get_client())
    with stub:
        yield service, stub
    stub.assert_no_pending_responses()


class TestCopyObject:
    def test_copies_within_the_bucket(self, service_and_stub):
        service, stub = service_and_stub
        stub.add_response(
            "copy_object",
            {},
            expected_params={
                "Bucket": BUCKET,
                "Key": "events/failed/p/a.json",
                "CopySource": {"Bucket": BUCKET, "Key": "events/otel/p/a.json"},
            },
        )

        service.copy_object("events/otel/p/a.json", "events/failed/p/a.json")

    def test_missing_source_raises(self, service_and_stub):
        service, stub = service_and_stub
        stub.add_client_error("copy_object", service_error_code="NoSuchKey", http_status_code=404)

        with pytest.raises(ClientError, match="NoSuchKey"):
            service.copy_object("events/otel/p/gone.json", "events/failed/p/gone.json")


class TestDeleteObject:
    def test_deletes_the_key(self, service_and_stub):
        service, stub = service_and_stub
        stub.add_response(
            "delete_object",
            {},
            expected_params={"Bucket": BUCKET, "Key": "events/otel/p/a.json"},
        )

        service.delete_object("events/otel/p/a.json")

    def test_error_raises(self, service_and_stub):
        service, stub = service_and_stub
        stub.add_client_error("delete_object", service_error_code="AccessDenied")

        with pytest.raises(ClientError, match="AccessDenied"):
            service.delete_object("events/otel/p/a.json")
