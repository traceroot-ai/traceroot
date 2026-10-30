"""Tests for S3Service.get_object_stream, the streaming read behind attachment serving."""

import io

import boto3
import pytest
from botocore.exceptions import ClientError
from botocore.response import StreamingBody
from botocore.stub import Stubber

from rest.services.s3 import S3ObjectStream, S3Service

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


def _body(data: bytes) -> StreamingBody:
    return StreamingBody(io.BytesIO(data), len(data))


class TestGetObjectStream:
    def test_returns_the_open_body_and_stored_metadata(self, service_and_stub):
        service, stub = service_and_stub
        stub.add_response(
            "get_object",
            {"Body": _body(b"\x89PNG-bytes"), "ContentType": "image/png", "ContentLength": 10},
            {"Bucket": BUCKET, "Key": KEY},
        )

        stored = service.get_object_stream(KEY)

        assert isinstance(stored, S3ObjectStream)
        assert stored.content_type == "image/png"
        assert stored.content_length == 10
        # Returned unread: the caller streams it.
        assert b"".join(stored.body.iter_chunks(4)) == b"\x89PNG-bytes"
        stored.body.close()

    def test_missing_metadata_is_none(self, service_and_stub):
        service, stub = service_and_stub
        stub.add_response("get_object", {"Body": _body(b"x")}, {"Bucket": BUCKET, "Key": KEY})

        stored = service.get_object_stream(KEY)

        assert stored is not None
        assert stored.content_type is None
        assert stored.content_length is None

    @pytest.mark.parametrize(
        ("code", "status"),
        [("NoSuchKey", 404), ("404", 404), ("NotFound", 404), ("NoSuchKey", 400)],
    )
    def test_missing_object_is_none(self, service_and_stub, code, status):
        service, stub = service_and_stub
        stub.add_client_error("get_object", service_error_code=code, http_status_code=status)
        assert service.get_object_stream(KEY) is None

    @pytest.mark.parametrize(
        ("code", "status"),
        [("AccessDenied", 403), ("InternalError", 500), ("SlowDown", 503)],
    )
    def test_other_errors_raise(self, service_and_stub, code, status):
        service, stub = service_and_stub
        stub.add_client_error("get_object", service_error_code=code, http_status_code=status)
        with pytest.raises(ClientError):
            service.get_object_stream(KEY)
