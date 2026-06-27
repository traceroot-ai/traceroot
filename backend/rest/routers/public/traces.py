"""Public traces endpoint for OTEL ingestion.

This endpoint receives OTLP trace data from SDKs and:
1. Stores OTEL JSON to S3/MinIO (durable buffer)
2. Enqueues a Celery task with S3 reference for async processing

The endpoint accepts OTLP protobuf format only:
- application/x-protobuf: Decoded and converted to camelCase JSON before storage

Authentication is via API key in the Authorization header:
    Authorization: Bearer <api_key>
"""

import gzip
import logging
import uuid
from datetime import UTC, datetime
from typing import Any

from fastapi import APIRouter, HTTPException, Request, Response, status
from google.protobuf.json_format import MessageToDict
from opentelemetry.proto.collector.trace.v1.trace_service_pb2 import (
    ExportTraceServiceRequest,
)
from pydantic import BaseModel

from ee.license import is_billing_enabled
from rest.rate_limit import key_ingest, limiter, resolve_limit

# Auth is defined in the shared public deps module so read routes don't import
# it from this ingestion endpoint. Re-exported here for backward compatibility.
from rest.routers.public.deps import (
    Auth,
    AuthResult,
    StampedAuth,
    authenticate_api_key,
)
from rest.services.s3 import get_s3_service
from worker.ingest_tasks import process_s3_traces

__all__ = ["AuthResult", "Auth", "authenticate_api_key", "router"]

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/public/traces", tags=["Traces (Public)"])


# Ingest shares the workspace/plan stamping wrapper with the public read routes
# (defined in deps); the limiter keys ingest by its own bucket via ``key_ingest``.
IngestAuth = StampedAuth


def decode_otlp_protobuf(data: bytes) -> dict[str, Any]:
    """Decode OTLP protobuf to a Python dict.

    Uses protobuf's MessageToDict for conversion, which produces
    a JSON-compatible dict with proper field naming.

    Args:
        data: Raw protobuf bytes

    Returns:
        Dict representation of the OTLP trace data
    """
    request = ExportTraceServiceRequest()
    request.ParseFromString(data)
    # MessageToDict converts protobuf to dict with camelCase field names
    # (standard OTLP JSON format) and proper handling of bytes (base64), enums, etc.
    return MessageToDict(request)


class IngestResponse(BaseModel):
    """Response for trace ingestion."""

    status: str
    file_key: str


@router.post("", response_model=IngestResponse)
@limiter.limit(resolve_limit, key_func=key_ingest)
async def ingest_traces(
    request: Request,
    response: Response,
    auth: IngestAuth,
):
    """Ingest OTLP trace data.

    Accepts OTLP protobuf format only (optionally gzip compressed).
    Protobuf is converted to camelCase JSON before storage in S3.

    S3 path: events/otel/{project_id}/{yyyy}/{mm}/{dd}/{hh}/{uuid}.json

    Headers:
        Authorization: Bearer <api_key>
        Content-Encoding: gzip (optional)
        Content-Type: application/x-protobuf

    Body:
        OTLP trace data in protobuf format
    """
    # Check if ingestion is blocked (free plan limit exceeded)
    # This flag is updated hourly by the billing worker
    # Skip enforcement when billing is disabled (e.g. self-hosted)
    if is_billing_enabled() and auth.ingestion_blocked:
        raise HTTPException(
            status_code=status.HTTP_402_PAYMENT_REQUIRED,
            detail="Free plan limit exceeded. Please upgrade to continue.",
        )

    project_id = auth.project_id

    # Validate Content-Type before reading body
    # Accept exactly 'application/x-protobuf' and variants with parameters
    content_type = request.headers.get("content-type")
    if not content_type:
        raise HTTPException(
            status_code=status.HTTP_415_UNSUPPORTED_MEDIA_TYPE,
            detail="Content-Type must be application/x-protobuf",
        )
    # handle parameters like 'application/x-protobuf; charset=utf-8'
    mime = content_type.split(";", 1)[0].strip().lower()
    if mime != "application/x-protobuf":
        raise HTTPException(
            status_code=status.HTTP_415_UNSUPPORTED_MEDIA_TYPE,
            detail="Content-Type must be application/x-protobuf",
        )

    # 1. Read body
    body = await request.body()

    if not body:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Empty request body",
        )

    # 2. Decompress if gzip
    content_encoding = request.headers.get("content-encoding", "")
    if "gzip" in content_encoding.lower():
        try:
            body = gzip.decompress(body)
        except Exception as e:
            logger.warning(f"Failed to decompress gzip: {e}")
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Invalid gzip payload",
            ) from e

    # 3. Decode protobuf to camelCase JSON (OTLP standard format)
    try:
        trace_data = decode_otlp_protobuf(body)
        logger.debug("Decoded OTLP protobuf to JSON")
    except Exception as e:
        logger.warning(f"Failed to parse OTLP protobuf: {e}")
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Malformed OTLP protobuf payload",
        ) from e

    # 4. Generate S3 key (time-partitioned)
    now = datetime.now(UTC)
    file_id = str(uuid.uuid4())
    s3_key = (
        f"events/otel/{project_id}/"
        f"{now.year}/{now.month:02d}/{now.day:02d}/{now.hour:02d}/"
        f"{file_id}.json"
    )

    # 5. Upload JSON to S3
    try:
        s3_service = get_s3_service()
        s3_service.ensure_bucket_exists()
        s3_service.upload_json(s3_key, trace_data)
        logger.info(f"Stored OTEL JSON to {s3_key} for project {project_id}")
    except Exception as e:
        logger.error(f"Failed to upload OTEL JSON to S3: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Storage error: {e}",
        ) from e

    # 6. Enqueue Celery task for async processing (S3 reference only, not full payload)
    try:
        process_s3_traces.delay(s3_key=s3_key, project_id=project_id)
        logger.info(f"Enqueued Celery task for {s3_key}")
    except Exception as e:
        # Log but don't fail the request - S3 has the data, can retry later
        logger.error(f"Failed to enqueue Celery task for {s3_key}: {e}")

    # 7. Return success (async processing happens in background)
    return IngestResponse(status="ok", file_key=s3_key)
