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
import hashlib
import logging
import uuid
from datetime import datetime, timezone
from typing import Annotated, Any

from fastapi import APIRouter, Depends, Header, HTTPException, Request, status
from google.protobuf.json_format import MessageToDict
from opentelemetry.proto.collector.trace.v1.trace_service_pb2 import (
    ExportTraceServiceRequest,
)
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from db.postgres.api_key import get_api_key_by_hash, update_api_key_last_used
from db.postgres.engine import get_session as get_postgres_session
from rest.services.s3 import get_s3_service
from worker.tasks import process_s3_traces

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/public/traces", tags=["Traces (Public)"])


async def get_db_session():
    """Get a database session."""
    async with get_postgres_session() as session:
        yield session


async def authenticate_api_key(
    authorization: Annotated[str | None, Header()] = None,
    session: AsyncSession = Depends(get_db_session),
) -> str:
    """Authenticate the request using API key and return the project_id.

    The API key should be in the Authorization header as:
        Authorization: Bearer <api_key>

    Args:
        authorization: Authorization header value.
        session: Database session.

    Returns:
        The project_id associated with the API key.

    Raises:
        HTTPException: If authentication fails.
    """
    if not authorization:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Missing Authorization header",
        )

    # Parse "Bearer <token>" format
    parts = authorization.split(" ", 1)
    if len(parts) != 2 or parts[0].lower() != "bearer":
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid Authorization header format. Expected: Bearer <api_key>",
        )

    api_key = parts[1]

    # Hash the key and look it up
    key_hash = hashlib.sha256(api_key.encode()).hexdigest()
    api_key_record = await get_api_key_by_hash(session, key_hash)

    if not api_key_record:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid API key",
        )

    # Check expiration
    if api_key_record.expires_at and api_key_record.expires_at < datetime.now(timezone.utc):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="API key has expired",
        )

    # Update last_used_at
    await update_api_key_last_used(session, api_key_record.id)
    await session.commit()

    return api_key_record.project_id


ProjectId = Annotated[str, Depends(authenticate_api_key)]


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
async def ingest_traces(
    request: Request,
    project_id: ProjectId,
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
                detail=f"Failed to decompress gzip: {e}",
            )

    # 3. Decode protobuf to camelCase JSON (OTLP standard format)
    try:
        trace_data = decode_otlp_protobuf(body)
        logger.debug("Decoded OTLP protobuf to JSON")
    except Exception as e:
        logger.warning(f"Failed to parse OTLP protobuf: {e}")
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Failed to parse OTLP protobuf: {e}",
        )

    # 4. Generate S3 key (time-partitioned)
    now = datetime.now(timezone.utc)
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
        )

    # 6. Enqueue Celery task for async processing (S3 reference only, not full payload)
    try:
        process_s3_traces.delay(s3_key=s3_key, project_id=project_id)
        logger.info(f"Enqueued Celery task for {s3_key}")
    except Exception as e:
        # Log but don't fail the request - S3 has the data, can retry later
        logger.error(f"Failed to enqueue Celery task for {s3_key}: {e}")

    # 7. Return success (async processing happens in background)
    return IngestResponse(status="ok", file_key=s3_key)
