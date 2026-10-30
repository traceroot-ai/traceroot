"""Reading staged OTLP batches back from S3: raw protobuf, gzip and JSON."""

import io
from unittest.mock import MagicMock

from rest.services.s3 import S3Service


class TestDownloadBytes:
    def test_returns_the_object_body_unchanged(self):
        service = S3Service(bucket_name="bucket")
        client = MagicMock()
        client.get_object.return_value = {"Body": io.BytesIO(b"\x1f\x8b raw bytes")}
        service._client = client

        assert service.download_bytes("events/otel/p/k.pb.gz") == b"\x1f\x8b raw bytes"
        client.get_object.assert_called_once_with(Bucket="bucket", Key="events/otel/p/k.pb.gz")
