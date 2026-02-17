"""Public traces endpoint for OTEL ingestion.

This endpoint receives OTLP trace data from SDKs and:
1. Stores OTEL JSON to S3/MinIO (durable buffer)
2. Enqueues a Celery task with S3 reference for async processing

The endpoint accepts OTLP protobuf format only:
- application/x-protobuf: Decoded and converted to camelCase JSON before storage

Authentication is via API key in the Authorization header:
    Authorization: Bearer <api_key>
"""

import asyncio
import gzip
import hashlib
import logging
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Annotated, Any

import httpx
from fastapi import APIRouter, Depends, Header, HTTPException, Request, status
from google.protobuf.json_format import MessageToDict
from opentelemetry.proto.collector.trace.v1.trace_service_pb2 import (
    ExportTraceServiceRequest,
)
from pydantic import BaseModel

from db.clickhouse.client import get_clickhouse_client
from rest.services.s3 import get_s3_service
from shared.config import settings
from worker.ingest_tasks import process_s3_traces

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/public/traces", tags=["Traces (Public)"])


@dataclass
class AuthResult:
    """Result of API key authentication with billing info."""

    project_id: str
    workspace_id: str
    workspace_project_ids: list[str]
    billing_plan: str
    free_plan_limit: int | None


async def authenticate_api_key(
    authorization: Annotated[str | None, Header()] = None,
) -> AuthResult:
    """Authenticate the request and return auth result with billing info."""
    if not authorization:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Missing Authorization header",
        )

    parts = authorization.split(" ", 1)
    if len(parts) != 2 or parts[0].lower() != "bearer":
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid Authorization header format. Expected: Bearer <api_key>",
        )

    api_key = parts[1]
    key_hash = hashlib.sha256(api_key.encode()).hexdigest()

    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            response = await client.post(
                f"{settings.traceroot_ui_url}/api/internal/validate-api-key",
                json={"keyHash": key_hash},
                headers={"X-Internal-Secret": settings.internal_api_secret},
            )
    except httpx.RequestError as e:
        logger.error(f"Failed to validate API key: {e}")
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Authentication service unavailable",
        ) from e

    if response.status_code == 401:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Authentication failed",
        )

    if response.status_code != 200:
        logger.error(f"Unexpected response from auth service: {response.status_code}")
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Authentication service error",
        )

    data = response.json()

    if not data.get("valid"):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail=data.get("error", "Invalid API key"),
        )

    return AuthResult(
        project_id=data["projectId"],
        workspace_id=data["workspaceId"],
        workspace_project_ids=data.get("workspaceProjectIds", [data["projectId"]]),
        billing_plan=data["billingPlan"],
        free_plan_limit=data.get("freePlanLimit"),
    )


Auth = Annotated[AuthResult, Depends(authenticate_api_key)]


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


def get_current_usage(project_ids: list[str]) -> int:
    """Get current month's usage (traces + spans) for all projects in workspace from ClickHouse."""
    if not project_ids:
        return 0

    ch = get_clickhouse_client()
    now = datetime.now(UTC)
    start_of_month = datetime(now.year, now.month, 1, tzinfo=UTC)
    start_str = start_of_month.strftime("%Y-%m-%d %H:%M:%S")

    result = ch.query(
        """
        SELECT count(*) as total
        FROM (
            SELECT 1 FROM traces
            WHERE project_id IN {project_ids:Array(String)}
              AND ch_create_time >= {start:String}
            UNION ALL
            SELECT 1 FROM spans
            WHERE project_id IN {project_ids:Array(String)}
              AND ch_create_time >= {start:String}
        )
        """,
        parameters={"project_ids": project_ids, "start": start_str},
    )
    return int(result.result_rows[0][0]) if result.result_rows else 0


@router.post("", response_model=IngestResponse)
async def ingest_traces(
    request: Request,
    auth: Auth,
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
    # Check free plan quota (workspace-level, not per-project)
    if auth.free_plan_limit is not None:
        current_usage = await asyncio.to_thread(get_current_usage, auth.workspace_project_ids)
        if current_usage >= auth.free_plan_limit:
            raise HTTPException(
                status_code=status.HTTP_402_PAYMENT_REQUIRED,
                detail=f"Free plan limit exceeded ({current_usage}/{auth.free_plan_limit} events). Please upgrade to continue.",
            )

    project_id = auth.project_id

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
        # Log but don't fail the request - S3 has the data, can retry later
        logger.error(f"Failed to enqueue Celery task for {s3_key}: {e}")

    # 7. Return success (async processing happens in background)
    return IngestResponse(status="ok", file_key=s3_key)
