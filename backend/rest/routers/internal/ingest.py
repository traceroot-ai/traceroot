"""Internal OTLP trace ingest (detector self-traces)."""

import gzip
import logging
import re
import zlib
from typing import Annotated

from fastapi import APIRouter, Depends, Header, HTTPException, Query, Request
from google.protobuf.message import DecodeError

from db.clickhouse.client import get_clickhouse_client
from rest.routers.internal.auth import InternalCaller, verify_internal_secret
from rest.routers.public.traces import decode_otlp_protobuf
from worker.detector_transform import UnattributableSpanError, transform_detector_traces

logger = logging.getLogger(__name__)

router = APIRouter()

_TRACE_ID_RE = re.compile(r"^[0-9a-f]{32}$")
_SPAN_ID_RE = re.compile(r"^[0-9a-f]{16}$")

# Which source a caller's traces are stored under. Fixed on the server: the caller
# proves who it is with its secret and gets exactly one source — there is no
# header or payload field that can change it.
SOURCE_BY_CALLER: dict[InternalCaller, str] = {"platform": "detector", "agent": "agent"}


@router.post("/traces")
async def ingest_internal_traces(
    request: Request,
    caller: Annotated[InternalCaller, Depends(verify_internal_secret)],
    project_id: str | None = Query(
        default=None, description="Fallback project for spans without a per-span attribute"
    ),
    x_project_id: Annotated[str | None, Header()] = None,
) -> dict:
    """Ingest detector self-traces (OTLP protobuf) directly into ClickHouse.

    Trusted, internal-only counterpart of the public OTLP ingest: the worker
    posts here with the shared secret, spans run through the detector-only
    multi-project wrapper (which calls the same transform as customer traffic,
    once per project group), and the rows are inserted in-process — no S3 hop and
    no detection enqueue, so a detector can never scan its own emission. Spans are inserted before the trace row
    so a partial failure cannot leave a trace row that points at missing
    spans. Every record is force-stamped with the source that belongs to the
    authenticated caller (platform → 'detector', agent → 'agent'), regardless
    of payload content.

    Project attribution is per-span and primary: the worker serves every
    project off one queue, so each span carries its own
    ``traceroot.project_id`` attribute. The request-level project id (header
    or query) is only a fallback for spans without the attribute.

    Args:
        request (Request): Raw request; body is OTLP protobuf, optionally
            gzip-compressed (Content-Encoding: gzip).
        caller (InternalCaller): Which internal caller authenticated the
            request — decides the `source` every record is stamped with.
        project_id (str | None): Fallback project for spans without a
            per-span attribute, as a query parameter; trusted because the
            route is secret-gated.
        x_project_id (str | None): Same, as the X-Project-Id header. The
            header wins when both are given. Optional — a batch whose every
            span carries the per-span attribute needs neither.

    Returns:
        dict: ``{"ok": True}`` on success.

    Raises:
        HTTPException: 400 on an empty body, an undecodable payload, a span
            with neither a per-span project attribute nor a request-level
            fallback, a trace id that is not exactly 32 lowercase hex chars,
            or a span/parent id that is present but not exactly 16.
    """
    fallback_project_id = x_project_id or project_id

    body = await request.body()
    if not body:
        raise HTTPException(status_code=400, detail="Empty request body")

    if "gzip" in request.headers.get("content-encoding", "").lower():
        try:
            body = gzip.decompress(body)
        except (OSError, EOFError, zlib.error) as e:
            # The only caller is our own worker tracer, so this means a bug
            # on our side — leave a breadcrumb (never the payload).
            logger.warning("Internal trace ingest: invalid gzip body: %s", e)
            raise HTTPException(status_code=400, detail="Invalid gzip body") from None

    try:
        otel_data = decode_otlp_protobuf(body)
    except DecodeError as e:
        logger.warning("Internal trace ingest: invalid OTLP protobuf: %s", e)
        raise HTTPException(status_code=400, detail="Invalid OTLP protobuf") from None

    try:
        traces, spans = transform_detector_traces(
            otel_data, fallback_project_id=fallback_project_id
        )
    except UnattributableSpanError as e:
        raise HTTPException(status_code=400, detail=str(e)) from None

    # Defense in depth: client-forced ids are only accepted in internal mode,
    # and even there they must look like real trace ids (dashless run_id).
    trace_ids = {t["trace_id"] for t in traces} | {s["trace_id"] for s in spans}
    for trace_id in trace_ids:
        if not _TRACE_ID_RE.match(trace_id):
            raise HTTPException(status_code=400, detail="trace_id must be 32 hex chars")
    for span in spans:
        if not _SPAN_ID_RE.match(span["span_id"]):
            raise HTTPException(status_code=400, detail="span_id must be 16 hex chars")
        parent_span_id = span.get("parent_span_id")
        # None is a root span, and every self-trace has exactly one — the
        # parent id is only constrained when present.
        if parent_span_id is not None and not _SPAN_ID_RE.match(parent_span_id):
            raise HTTPException(
                status_code=400, detail="parent_span_id must be 16 hex chars when present"
            )

    # The marker is a property of WHO called, never of the payload: the transform
    # never sets one, and this is the only place a non-'user' source is written.
    source = SOURCE_BY_CALLER[caller]
    for record in (*traces, *spans):
        record["source"] = source

    ch = get_clickhouse_client()
    ch.insert_spans_batch(spans)
    ch.insert_traces_batch(traces)
    return {"ok": True}
