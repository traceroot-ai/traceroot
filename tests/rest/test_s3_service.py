from unittest.mock import MagicMock

from rest.services.s3 import S3Service


def test_delete_object_delegates_to_s3_client():
    client = MagicMock()
    service = S3Service(bucket_name="trace-bucket")
    service._client = client

    service.delete_object("events/otel/project/key.json")

    client.delete_object.assert_called_once_with(
        Bucket="trace-bucket",
        Key="events/otel/project/key.json",
    )
