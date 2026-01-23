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
import os
from typing import Any

import boto3
from botocore.config import Config
from botocore.exceptions import ClientError

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
            endpoint_url: S3/MinIO endpoint URL.
            access_key_id: AWS access key ID.
            secret_access_key: AWS secret access key.
            bucket_name: S3 bucket name.
            region: AWS region.
        """
        self._endpoint_url = endpoint_url or os.getenv("S3_ENDPOINT_URL")
        self._access_key_id = access_key_id or os.getenv("S3_ACCESS_KEY_ID")
        self._secret_access_key = secret_access_key or os.getenv("S3_SECRET_ACCESS_KEY")
        self._bucket_name = bucket_name or os.getenv("S3_BUCKET_NAME", "traceroot")
        self._region = region or os.getenv("S3_REGION", "us-east-1")

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

    def upload_otel_batch(self, s3_key: str, body: bytes) -> None:
        """Upload raw OTLP batch to S3.

        Stores the raw OTLP JSON exactly as received from the SDK,
        without any parsing or transformation.

        Args:
            s3_key: Full S3 key path (e.g., events/otel/proj_xxx/2026/01/22/08/uuid.json)
            body: Raw OTLP JSON bytes
        """
        client = self._get_client()
        client.put_object(
            Bucket=self._bucket_name,
            Key=s3_key,
            Body=body,
            ContentType="application/json",
        )
        logger.debug(f"Uploaded OTEL batch to s3://{self._bucket_name}/{s3_key}")

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


# Global singleton instance
_s3_service: S3Service | None = None


def get_s3_service() -> S3Service:
    """Get the global S3 service instance."""
    global _s3_service
    if _s3_service is None:
        _s3_service = S3Service()
    return _s3_service
