"""Load OTLP trace batches staged by the ingest API.

The suffix of a batch's key names its format, whatever prefix the batch is
stored under:

- ``.pb.gz``: a gzip-encoded OTLP protobuf request body, stored as received.
- ``.pb``: an uncompressed OTLP protobuf request body, stored as received.
- ``.json``: the request already decoded to OTLP JSON.

Every format loads to the same dict, so the transform cannot tell them apart.
"""

from typing import TYPE_CHECKING, Any

from google.protobuf.json_format import MessageToDict
from opentelemetry.proto.collector.trace.v1.trace_service_pb2 import (
    ExportTraceServiceRequest,
)

from shared.bounded_gzip import gunzip
from shared.config import settings

if TYPE_CHECKING:  # pragma: no cover - annotation only
    from rest.services.s3 import S3Service


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


def load_staged_batch(s3_service: "S3Service", s3_key: str) -> dict:
    """Download a staged batch and return it as OTLP JSON.

    Args:
        s3_service (S3Service): Service for the bucket the batch is stored in.
        s3_key (str): The staged object's key; its suffix names the format.

    Returns:
        dict: The batch as camelCase OTLP JSON, the form ``MessageToDict`` renders.

    Raises:
        ValueError: If the key ends in none of the known suffixes.
        GzipTooLargeError: If a ``.pb.gz`` body unzips past the ingest limit.
        zlib.error: If a ``.pb.gz`` body is not valid gzip.
        EOFError: If a ``.pb.gz`` body is truncated.
        DecodeError: If the protobuf does not parse.
    """
    if s3_key.endswith(".pb.gz"):
        body = gunzip(s3_service.download_bytes(s3_key), settings.ingest.max_unzipped_bytes)
        return decode_otlp_protobuf(body)
    if s3_key.endswith(".pb"):
        return decode_otlp_protobuf(s3_service.download_bytes(s3_key))
    if s3_key.endswith(".json"):
        return s3_service.download_json(s3_key)
    raise ValueError(f"Unknown staged batch format: {s3_key}")
