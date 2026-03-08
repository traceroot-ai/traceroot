"""S3/MinIO service for storing OTEL trace data.

This service handles uploading raw OTEL trace batches to S3/MinIO for
durable storage. Data is stored using a time-partitioned path structure:

    events/otel/{project_id}/{yyyy}/{mm}/{dd}/{hh}/{uuid}.json

This structure enables:
- Fast writes (no lookup needed)
- Easy worker polling by time range
- Simple retention management by date prefix
- No hot spots from concurrent trace writes

Later, a worker will process these files and insert into ClickHouse.
"""

import logging
from typing import Any

import boto3
from botocore.config import Config
from botocore.exceptions import ClientError

from shared.config import settings

logger = logging.getLogger(__name__)


class S3Service:
    """Service for uploading OTEL data to S3/MinIO."""

    def __init__(
        self,
        endpoint_url: str | None = None,
        access_key_id: str | None = None,
        secret_access_key: str | None = None,
        bucket_name: str | None = None,
        region: str | None = None,
    ):
        """Initialize S3 service.

        Args:
            endpoint_url: S3/MinIO endpoint URL. Defaults to settings.
            access_key_id: AWS access key ID. Defaults to settings.
            secret_access_key: AWS secret access key. Defaults to settings.
            bucket_name: S3 bucket name. Defaults to settings.
            region: AWS region. Defaults to settings.
        """
        s3 = settings.s3
        self._endpoint_url = (endpoint_url or s3.endpoint_url) or None
        self._access_key_id = access_key_id or s3.access_key_id
        self._secret_access_key = secret_access_key or s3.secret_access_key
        self._bucket_name = bucket_name or s3.bucket_name
        self._region = region or s3.region

        self._client: Any = None

    def _get_client(self):
        """Get or create the S3 client."""
        if self._client is None:
            config = Config(
                retries={"max_attempts": 3, "mode": "adaptive"},
                connect_timeout=5,
                read_timeout=30,
            )
            self._client = boto3.client(
                "s3",
                endpoint_url=self._endpoint_url,
                aws_access_key_id=self._access_key_id,
                aws_secret_access_key=self._secret_access_key,
                region_name=self._region,
                config=config,
            )
        return self._client

    def ensure_bucket_exists(self) -> None:
        """Ensure the bucket exists, create if not."""
        client = self._get_client()
        try:
            client.head_bucket(Bucket=self._bucket_name)
        except ClientError as e:
            error_code = e.response.get("Error", {}).get("Code")
            if error_code == "404":
                logger.info(f"Creating bucket: {self._bucket_name}")
                client.create_bucket(Bucket=self._bucket_name)
            else:
                raise

    def upload_json(self, s3_key: str, data: dict | list) -> None:
        """Upload JSON data to S3.

        Serializes the data to JSON and uploads to S3.

        Args:
            s3_key: Full S3 key path
            data: Python dict or list to serialize as JSON
        """
        import json

        client = self._get_client()
        json_bytes = json.dumps(data, ensure_ascii=False).encode("utf-8")
        client.put_object(
            Bucket=self._bucket_name,
            Key=s3_key,
            Body=json_bytes,
            ContentType="application/json",
        )
        logger.debug(f"Uploaded JSON to s3://{self._bucket_name}/{s3_key}")

    def download_json(self, s3_key: str) -> dict | list:
        """Download and parse JSON data from S3.

        Args:
            s3_key: Full S3 key path

        Returns:
            Parsed JSON data (dict or list)

        Raises:
            ClientError: If the file doesn't exist or download fails
        """
        import json

        client = self._get_client()
        response = client.get_object(Bucket=self._bucket_name, Key=s3_key)
        body = response["Body"].read()
        return json.loads(body.decode("utf-8"))


# Global singleton instance
_s3_service: S3Service | None = None


def get_s3_service() -> S3Service:
    """Get the global S3 service instance."""
    global _s3_service
    if _s3_service is None:
        _s3_service = S3Service()
    return _s3_service
