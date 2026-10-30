"""Decode OTLP trace batches staged by the ingest API."""

from typing import Any

from google.protobuf.json_format import MessageToDict
from opentelemetry.proto.collector.trace.v1.trace_service_pb2 import (
    ExportTraceServiceRequest,
)


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
