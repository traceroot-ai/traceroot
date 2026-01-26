"""Public traces endpoint for OTEL ingestion.

This endpoint receives OTLP trace data (protobuf format) from SDKs,
decodes it to JSON, and stores to S3/MinIO for later processing.

Authentication is via API key in the Authorization header:
    Authorization: Bearer <api_key>
"""

import base64
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


def decode_otlp_id(b64_value: str) -> str:
    """Convert base64-encoded OTLP ID to hex string.

    OTLP protobuf encodes trace_id (16 bytes) and span_id (8 bytes) as
    base64 in JSON format. This converts them to readable hex strings.

    Args:
        b64_value: Base64-encoded ID string

    Returns:
        Hex string representation (e.g., "46021631567b17f7b8659ccf274f6ecb")
    """
    return base64.b64decode(b64_value).hex()


def decode_span_ids(trace_data: dict[str, Any]) -> dict[str, Any]:
    """Decode all trace_id, span_id, and parent_span_id fields from base64 to hex.

    Recursively traverses the OTLP trace data structure and converts
    all ID fields from base64 to hex for easier debugging and readability.

    Args:
        trace_data: OTLP trace data dict from MessageToDict

    Returns:
        Modified trace data with hex-encoded IDs
    """
    # Process resource_spans -> scope_spans -> spans
    for resource_span in trace_data.get("resource_spans", []):
        for scope_span in resource_span.get("scope_spans", []):
            for span in scope_span.get("spans", []):
                # Decode trace_id
                if "trace_id" in span and span["trace_id"]:
                    try:
                        span["trace_id"] = decode_otlp_id(span["trace_id"])
                    except Exception as e:
                        logger.warning(f"Failed to decode trace_id: {e}")

                # Decode span_id
                if "span_id" in span and span["span_id"]:
                    try:
                        span["span_id"] = decode_otlp_id(span["span_id"])
                    except Exception as e:
                        logger.warning(f"Failed to decode span_id: {e}")

                # Decode parent_span_id
                if "parent_span_id" in span and span["parent_span_id"]:
                    try:
                        span["parent_span_id"] = decode_otlp_id(span["parent_span_id"])
                    except Exception as e:
                        logger.warning(f"Failed to decode parent_span_id: {e}")

    return trace_data


def decode_otlp_protobuf(data: bytes) -> dict[str, Any]:
    """Decode OTLP protobuf to a Python dict with hex-encoded IDs.

    Args:
        data: Raw protobuf bytes

    Returns:
        Dict representation of the OTLP trace data with hex-encoded IDs
    """
    request = ExportTraceServiceRequest()
    request.ParseFromString(data)
    trace_data = MessageToDict(request, preserving_proto_field_name=True)
    return decode_span_ids(trace_data)


class IngestResponse(BaseModel):
    """Response for trace ingestion."""

    status: str
    file_key: str


@router.post("", response_model=IngestResponse)
async def ingest_traces(
    request: Request,
    project_id: ProjectId,
):
    """Ingest OTLP trace data (protobuf format only).

    S3 path: events/otel/{project_id}/{yyyy}/{mm}/{dd}/{hh}/{uuid}.json

    Headers:
        Authorization: Bearer <api_key>
        Content-Encoding: gzip (optional)
        Content-Type: application/x-protobuf

    Body:
        OTLP trace data in protobuf format (ExportTraceServiceRequest)
    """
    # 1. Validate content type (protobuf only)
    content_type = request.headers.get("content-type", "")
    if "application/x-protobuf" not in content_type and "application/protobuf" not in content_type:
        raise HTTPException(
            status_code=status.HTTP_415_UNSUPPORTED_MEDIA_TYPE,
            detail=f"Unsupported content type: {content_type}. Expected application/x-protobuf",
        )

    # 2. Read body
    body = await request.body()
    if not body:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Empty request body",
        )

    # 3. Decompress if gzip
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

    # 4. Decode protobuf
    try:
        trace_data = decode_otlp_protobuf(body)
    except Exception as e:
        logger.warning(f"Failed to parse OTLP protobuf: {e}")
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Failed to parse OTLP protobuf: {e}",
        )

    # 5. Generate S3 key (time-partitioned)
    now = datetime.now(timezone.utc)
    file_id = str(uuid.uuid4())
    s3_key = (
        f"events/otel/{project_id}/"
        f"{now.year}/{now.month:02d}/{now.day:02d}/{now.hour:02d}/"
        f"{file_id}.json"
    )

    # 6. Upload JSON to S3
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

    # 7. Return success
    return IngestResponse(status="ok", file_key=s3_key)
