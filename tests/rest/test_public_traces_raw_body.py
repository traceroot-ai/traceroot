"""The ingest route stages the original request body, and the worker reads it back."""

from unittest.mock import MagicMock

from rest.services.s3 import S3Service


class TestUploadBytes:
    def test_stores_the_bytes_as_given_without_a_content_encoding(self):
        service = S3Service(bucket_name="bucket")
        client = MagicMock()
        service._client = client

        service.upload_bytes("events/otel/p/k.pb.gz", b"\x1f\x8b body", "application/x-protobuf")

        client.put_object.assert_called_once_with(
            Bucket="bucket",
            Key="events/otel/p/k.pb.gz",
            Body=b"\x1f\x8b body",
            ContentType="application/x-protobuf",
        )
