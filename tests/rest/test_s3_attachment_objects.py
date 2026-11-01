"""Tests for the S3Service existence check and conditional write used for attachments."""

import boto3
import pytest
from botocore.exceptions import ClientError
from botocore.stub import Stubber

from rest.services.s3 import S3Service

BUCKET = "test-bucket"
KEY = "attachments/proj-1/sha256/" + "ab" * 32


@pytest.fixture()
def service_and_stub():
    """An S3Service whose client is a stubbed boto3 client, so nothing leaves the process."""
    client = boto3.client(
        "s3",
        region_name="us-east-1",
        aws_access_key_id="test",
        aws_secret_access_key="test",
    )
    service = S3Service(bucket_name=BUCKET, access_key_id="test", secret_access_key="test")
    service._client = client
    with Stubber(client) as stub:
        yield service, stub
        stub.assert_no_pending_responses()


class TestObjectExists:
    def test_present(self, service_and_stub):
        service, stub = service_and_stub
        stub.add_response("head_object", {}, {"Bucket": BUCKET, "Key": KEY})
        assert service.object_exists(KEY) is True

    @pytest.mark.parametrize("code", ["404", "NoSuchKey", "NotFound"])
    def test_missing(self, service_and_stub, code):
        service, stub = service_and_stub
        stub.add_client_error("head_object", service_error_code=code, http_status_code=404)
        assert service.object_exists(KEY) is False

    @pytest.mark.parametrize(("code", "status"), [("403", 403), ("InternalError", 500)])
    def test_other_errors_raise(self, service_and_stub, code, status):
        service, stub = service_and_stub
        stub.add_client_error("head_object", service_error_code=code, http_status_code=status)
        with pytest.raises(ClientError):
            service.object_exists(KEY)


class TestPutObjectIfAbsent:
    def test_writes_with_if_none_match(self, service_and_stub):
        service, stub = service_and_stub
        stub.add_response(
            "put_object",
            {},
            {
                "Bucket": BUCKET,
                "Key": KEY,
                "Body": b"\x89PNG",
                "ContentType": "image/png",
                "IfNoneMatch": "*",
            },
        )
        assert service.put_object_if_absent(KEY, b"\x89PNG", "image/png") is True

    def test_precondition_failed_counts_as_success(self, service_and_stub):
        service, stub = service_and_stub
        stub.add_client_error(
            "put_object", service_error_code="PreconditionFailed", http_status_code=412
        )
        assert service.put_object_if_absent(KEY, b"\x89PNG", "image/png") is False

    @pytest.mark.parametrize(
        ("code", "status"),
        [("ConditionalRequestConflict", 409), ("AccessDenied", 403), ("SlowDown", 503)],
    )
    def test_other_errors_raise(self, service_and_stub, code, status):
        service, stub = service_and_stub
        stub.add_client_error("put_object", service_error_code=code, http_status_code=status)
        with pytest.raises(ClientError):
            service.put_object_if_absent(KEY, b"\x89PNG", "image/png")
