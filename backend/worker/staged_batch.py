"""Load OTLP trace batches staged by the ingest API.

The suffix of a batch's key names its format, whatever prefix the batch is
stored under:

- ``.pb.gz``: a gzip-encoded OTLP protobuf request body, stored as received.
- ``.pb``: an uncompressed OTLP protobuf request body, stored as received.
- ``.json``: the request already decoded to OTLP JSON.

Every format loads to the same dict, so the transform cannot tell them apart.
A ``.pb`` or ``.pb.gz`` body that doesn't decode raises ``UndecodableBatchError``:
the stored bytes never change, so no later attempt could decode them either.
"""

import zlib
from typing import TYPE_CHECKING, Any

from google.protobuf.message import DecodeError

from shared.bounded_gzip import GzipTooLargeError, gunzip
from shared.config import settings
from shared.otlp import decode_otlp_protobuf
from worker.batch_budget import BudgetExceededError, check_batch_budget

if TYPE_CHECKING:  # pragma: no cover - annotation only
    from rest.services.s3 import S3Service


class UndecodableBatchError(ValueError):
    """A staged batch whose stored bytes can never be decoded; retrying can't help."""


def _decode_body(body: bytes, gzipped: bool) -> dict[str, Any]:
    """Decode a raw request body, raising ``UndecodableBatchError`` if it can't be.

    The batch's structure is checked against the ingest budgets before it is
    parsed, since parsing is where the memory goes.
    """
    try:
        if gzipped:
            body = gunzip(body, settings.ingest.max_unzipped_bytes)
        check_batch_budget(body, settings.ingest.max_spans, settings.ingest.max_objects)
        return decode_otlp_protobuf(body)
    except (BudgetExceededError, DecodeError, GzipTooLargeError, zlib.error, EOFError) as e:
        raise UndecodableBatchError(f"{type(e).__name__}: {e}") from e


def load_staged_batch(s3_service: "S3Service", s3_key: str) -> dict:
    """Download a staged batch and return it as OTLP JSON.

    Args:
        s3_service (S3Service): Service for the bucket the batch is stored in.
        s3_key (str): The staged object's key; its suffix names the format.

    Returns:
        dict: The batch as camelCase OTLP JSON, the form ``MessageToDict`` renders.

    Raises:
        UndecodableBatchError: If the key ends in none of the known suffixes, or a
            ``.pb`` or ``.pb.gz`` body can't be decoded: invalid or truncated gzip,
            gzip that unzips past the ingest limit, a protobuf that doesn't parse,
            or one holding more spans or objects than ``INGEST_MAX_SPANS`` or
            ``INGEST_MAX_OBJECTS`` allow. The original error is its ``__cause__``.
            A failed download raises as it is, since another attempt may succeed.
    """
    if s3_key.endswith(".pb.gz"):
        return _decode_body(s3_service.download_bytes(s3_key), gzipped=True)
    if s3_key.endswith(".pb"):
        return _decode_body(s3_service.download_bytes(s3_key), gzipped=False)
    # Legacy: batches staged as OTLP JSON by an older API; remove once those tasks have drained.
    if s3_key.endswith(".json"):
        return s3_service.download_json(s3_key)
    raise UndecodableBatchError(f"Unknown staged batch format: {s3_key}")
