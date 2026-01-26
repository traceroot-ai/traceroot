"""Integration tests for the public traces endpoint.

Tests that OTLP protobuf data is correctly decoded and IDs are
converted from base64 to hex format before storage.
"""

from unittest.mock import MagicMock, patch

import pytest
from fastapi.testclient import TestClient
from opentelemetry.proto.collector.trace.v1.trace_service_pb2 import (
    ExportTraceServiceRequest,
)
from opentelemetry.proto.common.v1.common_pb2 import AnyValue, KeyValue
from opentelemetry.proto.resource.v1.resource_pb2 import Resource
from opentelemetry.proto.trace.v1.trace_pb2 import (
    ResourceSpans,
    ScopeSpans,
    Span,
)

from rest.main import app
from rest.routers.public.traces import authenticate_api_key


@pytest.fixture
def mock_s3():
    """Mock S3 service to capture uploaded data."""
    captured = {"key": None, "data": None}

    mock_service = MagicMock()

    def capture_upload(s3_key, data):
        captured["key"] = s3_key
        captured["data"] = data

    mock_service.upload_json.side_effect = capture_upload
    mock_service.ensure_bucket_exists.return_value = None

    with patch("rest.routers.public.traces.get_s3_service") as mock:
        mock.return_value = mock_service
        yield captured


@pytest.fixture
def client():
    """Create test client with mocked auth."""
    # Override the auth dependency to skip DB lookup
    app.dependency_overrides[authenticate_api_key] = lambda: "test-project-123"

    with TestClient(app, raise_server_exceptions=False) as c:
        yield c

    # Clean up
    app.dependency_overrides.clear()


def create_test_protobuf(
    trace_id: bytes,
    span_id: bytes,
    parent_span_id: bytes | None = None,
    span_name: str = "test-span",
) -> bytes:
    """Create a test OTLP protobuf payload with specific IDs.

    Args:
        trace_id: 16-byte trace ID
        span_id: 8-byte span ID
        parent_span_id: Optional 8-byte parent span ID
        span_name: Name for the span

    Returns:
        Serialized protobuf bytes
    """
    span = Span(
        trace_id=trace_id,
        span_id=span_id,
        name=span_name,
        start_time_unix_nano=1700000000000000000,
        end_time_unix_nano=1700000001000000000,
    )

    if parent_span_id:
        span.parent_span_id = parent_span_id

    scope_spans = ScopeSpans(spans=[span])

    resource = Resource(
        attributes=[
            KeyValue(key="service.name", value=AnyValue(string_value="test-service"))
        ]
    )
    resource_spans = ResourceSpans(
        resource=resource,
        scope_spans=[scope_spans],
    )

    request = ExportTraceServiceRequest(resource_spans=[resource_spans])
    return request.SerializeToString()


class TestTraceIdDecoding:
    """Test that trace/span IDs are decoded from base64 to hex."""

    def test_trace_id_decoded_to_hex(self, client, mock_s3):
        """Test that trace_id is stored as hex, not base64."""
        # Known trace_id: 16 bytes
        # Hex: 0123456789abcdef0123456789abcdef
        trace_id = bytes.fromhex("0123456789abcdef0123456789abcdef")
        span_id = bytes.fromhex("fedcba9876543210")

        protobuf_data = create_test_protobuf(trace_id, span_id)

        response = client.post(
            "/api/v1/public/traces",
            content=protobuf_data,
            headers={
                "Content-Type": "application/x-protobuf",
                "Authorization": "Bearer test-key",
            },
        )

        assert response.status_code == 200

        # Check the captured S3 data
        stored_data = mock_s3["data"]
        assert stored_data is not None

        # Navigate to the span
        span = stored_data["resource_spans"][0]["scope_spans"][0]["spans"][0]

        # Verify trace_id is hex (not base64)
        assert span["trace_id"] == "0123456789abcdef0123456789abcdef"
        assert span["span_id"] == "fedcba9876543210"

    def test_parent_span_id_decoded_to_hex(self, client, mock_s3):
        """Test that parent_span_id is also decoded to hex."""
        trace_id = bytes.fromhex("aaaabbbbccccddddeeeeffffaaaabbbb")
        span_id = bytes.fromhex("1111222233334444")
        parent_span_id = bytes.fromhex("5555666677778888")

        protobuf_data = create_test_protobuf(trace_id, span_id, parent_span_id)

        response = client.post(
            "/api/v1/public/traces",
            content=protobuf_data,
            headers={
                "Content-Type": "application/x-protobuf",
                "Authorization": "Bearer test-key",
            },
        )

        assert response.status_code == 200

        span = mock_s3["data"]["resource_spans"][0]["scope_spans"][0]["spans"][0]

        assert span["trace_id"] == "aaaabbbbccccddddeeeeffffaaaabbbb"
        assert span["span_id"] == "1111222233334444"
        assert span["parent_span_id"] == "5555666677778888"

    def test_s3_key_contains_project_id(self, client, mock_s3):
        """Test that the S3 key includes the project ID."""
        trace_id = bytes.fromhex("0" * 32)
        span_id = bytes.fromhex("0" * 16)

        protobuf_data = create_test_protobuf(trace_id, span_id)

        response = client.post(
            "/api/v1/public/traces",
            content=protobuf_data,
            headers={
                "Content-Type": "application/x-protobuf",
                "Authorization": "Bearer test-key",
            },
        )

        assert response.status_code == 200

        s3_key = mock_s3["key"]
        assert "test-project-123" in s3_key
        assert s3_key.startswith("events/otel/")
        assert s3_key.endswith(".json")


class TestContentTypeValidation:
    """Test that only protobuf content type is accepted."""

    def test_rejects_json_content_type(self, client, mock_s3):
        """Test that application/json is rejected with 415."""
        response = client.post(
            "/api/v1/public/traces",
            content=b'{"resourceSpans": []}',
            headers={
                "Content-Type": "application/json",
                "Authorization": "Bearer test-key",
            },
        )

        assert response.status_code == 415
        assert "Unsupported content type" in response.json()["detail"]

    def test_rejects_missing_content_type(self, client, mock_s3):
        """Test that missing content type is rejected."""
        response = client.post(
            "/api/v1/public/traces",
            content=b"some data",
            headers={
                "Authorization": "Bearer test-key",
            },
        )

        assert response.status_code == 415

    def test_accepts_protobuf_content_type(self, client, mock_s3):
        """Test that application/x-protobuf is accepted."""
        trace_id = bytes.fromhex("0" * 32)
        span_id = bytes.fromhex("0" * 16)
        protobuf_data = create_test_protobuf(trace_id, span_id)

        response = client.post(
            "/api/v1/public/traces",
            content=protobuf_data,
            headers={
                "Content-Type": "application/x-protobuf",
                "Authorization": "Bearer test-key",
            },
        )

        assert response.status_code == 200


class TestErrorHandling:
    """Test error handling for invalid requests."""

    def test_empty_body_returns_400(self, client, mock_s3):
        """Test that empty body returns 400."""
        response = client.post(
            "/api/v1/public/traces",
            content=b"",
            headers={
                "Content-Type": "application/x-protobuf",
                "Authorization": "Bearer test-key",
            },
        )

        assert response.status_code == 400
        assert "Empty request body" in response.json()["detail"]

    def test_invalid_protobuf_returns_400(self, client, mock_s3):
        """Test that invalid protobuf data returns 400."""
        response = client.post(
            "/api/v1/public/traces",
            content=b"not valid protobuf data",
            headers={
                "Content-Type": "application/x-protobuf",
                "Authorization": "Bearer test-key",
            },
        )

        assert response.status_code == 400
        assert "Failed to parse OTLP protobuf" in response.json()["detail"]
