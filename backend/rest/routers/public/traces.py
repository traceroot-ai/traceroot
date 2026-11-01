"""Public traces endpoint for OTEL ingestion.

This endpoint receives OTLP trace data from SDKs and:
1. Stores OTEL JSON to S3/MinIO (durable buffer)
2. Enqueues a Celery task with S3 reference for async processing

The endpoint accepts OTLP protobuf format only:
- application/x-protobuf: Decoded and converted to camelCase JSON before storage

Authentication is via API key in the Authorization header:
    Authorization: Bearer <api_key>
"""

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

# KeyAuth is defined in the shared public deps module so read routes don't import
# it from this ingestion endpoint. Re-exported here for backward compatibility.
from rest.routers.public.deps import (
    AuthResult,
    KeyAuth,
    KeyStampedAuth,
    authenticate_api_key,
)
from rest.services.s3 import get_s3_service
from shared.bounded_gzip import GzipTooLargeError, gunzip
from shared.config import settings
from worker.ingest_tasks import process_s3_traces

__all__ = ["AuthResult", "KeyAuth", "authenticate_api_key", "router"]

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/public/traces", tags=["Traces"])


# Ingest shares the workspace/plan stamping wrapper with the public read routes
# (defined in deps); the limiter keys ingest by its own bucket via ``key_ingest``.
IngestAuth = KeyStampedAuth

# How long an exporter should wait before resending a batch that could not be queued.
_ENQUEUE_RETRY_AFTER_SECONDS = 5


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


def _body_too_large(detail: str) -> HTTPException:
    """Log and build the 413 for a body over one of the ingest size limits."""
    logger.warning(f"Refused trace ingest request: {detail}")
    return HTTPException(status_code=status.HTTP_413_CONTENT_TOO_LARGE, detail=detail)


async def _read_capped_body(request: Request, max_bytes: int) -> bytes:
    """Buffer the request body, refusing anything over ``max_bytes``.

    A declared ``Content-Length`` over the cap is refused before any of the body
    is read. The running count is what enforces the cap, since a chunked body has
    no length and a declared one can be wrong.

    Args:
        request (Request): The ingest request.
        max_bytes (int): The most body bytes accepted, as sent on the wire.

    Returns:
        bytes: The body as sent.

    Raises:
        HTTPException: 413 if the body exceeds ``max_bytes``.
    """
    too_large = f"Request body exceeds {max_bytes} bytes"
    declared = request.headers.get("content-length")
    if declared is not None and declared.isdigit() and int(declared) > max_bytes:
        raise _body_too_large(too_large)
    chunks: list[bytes] = []
    total = 0
    async for chunk in request.stream():
        total += len(chunk)
        if total > max_bytes:
            raise _body_too_large(too_large)
        chunks.append(chunk)
    return b"".join(chunks)


class IngestResponse(BaseModel):
    """Response for trace ingestion."""

    status: str
    file_key: str


@router.post("", response_model=IngestResponse, operation_id="ingest_traces")
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

    # 1. Read body, refusing anything over the request cap
    body = await _read_capped_body(request, settings.ingest.max_request_bytes)

    if not body:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Empty request body",
        )

    # 2. Decompress if gzip, refusing anything that unzips past the cap
    content_encoding = request.headers.get("content-encoding", "")
    if "gzip" in content_encoding.lower():
        try:
            body = gunzip(body, settings.ingest.max_unzipped_bytes)
        except GzipTooLargeError as e:
            raise _body_too_large(f"Decompressed request body exceeds {e.max_bytes} bytes") from e
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
            detail=f"Failed to parse OTLP protobuf: {e}",
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
        # Only a queued task ever reads the staged object, so answering 200 here
        # would drop the batch. A 503 makes the exporter send it again; the staged
        # copy is left where it is and never processed.
        logger.error(f"Failed to enqueue Celery task for {s3_key}: {e}")
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Could not queue the batch for processing. Retry shortly.",
            headers={"Retry-After": str(_ENQUEUE_RETRY_AFTER_SECONDS)},
        ) from e

    # 7. Return success (async processing happens in background)
    return IngestResponse(status="ok", file_key=s3_key)
