"""Live trace streaming via Server-Sent Events (SSE).

Subscribes to a Redis pub/sub channel for a specific trace and streams
span updates to the client in real time.
"""

import asyncio
import json
import logging
import time
from datetime import UTC, datetime

from fastapi import APIRouter, Request
from starlette.responses import StreamingResponse

from rest.retention import enforce_retention_by_time
from rest.routers.deps import ProjectAccess
from rest.services.trace_reader import get_trace_reader_service
from shared.config import settings

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/projects/{project_id}/traces/{trace_id}", tags=["Live"])

HEARTBEAT_INTERVAL = 15  # seconds
MAX_STREAM_SECONDS = 600  # 10 minutes — hard ceiling for idle connections
# Read once from settings so tests can still patch the module constant. Kept
# above the SDK's 5s default flush interval so a quiet window can't expire
# between two batches of the same live trace.
TRACE_COMPLETE_QUIET_SECONDS = settings.trace_complete_quiet_seconds


def _completion_state_in_clickhouse(
    project_id: str, trace_id: str
) -> tuple[datetime | None, datetime | None]:
    """Return (root end time, last ingest time) for this trace.

    The root end time is None while the root span is still open. A root span
    with an end time is a completion candidate, not proof that no more
    descendant spans can arrive — some streaming handlers finish the root span
    before background work emits its children, so the last ingest time
    (max ch_update_time) tells us whether spans are still actively arriving.
    """
    from db.clickhouse.client import get_clickhouse_client

    ch_client = get_clickhouse_client()
    # Dedup ReplacingMergeTree rows without FINAL: keep the latest version per
    # span_id (filtered to this trace), then aggregate on the deduped rows.
    result = ch_client.query(
        """
        SELECT
            maxIf(span_end_time, isNull(parent_span_id)),
            max(ch_update_time)
        FROM (
            SELECT parent_span_id, span_end_time, ch_update_time FROM spans
            WHERE project_id = {project_id:String}
              AND trace_id   = {trace_id:String}
            ORDER BY ch_update_time DESC
            LIMIT 1 BY span_id
        )
        """,
        parameters={"project_id": project_id, "trace_id": trace_id},
    )
    rows = result.result_rows
    if not rows:
        return None, None
    return rows[0][0], rows[0][1]


@router.get("/live")
async def live_trace_stream(
    request: Request,
    project_id: str,
    trace_id: str,
    _access: ProjectAccess,
):
    """Stream live span updates for a trace via SSE.

    The client receives:
    - `event: spans` with span data as each batch is ingested
    - `event: trace_complete` after root completion and a short quiet window
    - Heartbeat comments every 15s to keep the connection alive

    A root span with an end time is treated as a completion candidate. The
    stream stays open for a short quiet window so late descendant spans still
    reach the client before trace_complete closes the frontend stream.
    """

    service = get_trace_reader_service()
    trace = service.get_trace(project_id=project_id, trace_id=trace_id)
    if trace:
        enforce_retention_by_time(_access.billing_plan, trace.get("trace_start_time"))

    async def event_generator():
        from shared.redis import get_async_redis_client

        redis_client = get_async_redis_client()
        pubsub = redis_client.pubsub()
        channel = f"trace:live:{project_id}:{trace_id}"

        try:
            # Subscribe BEFORE checking ClickHouse so we don't miss events from
            # Celery tasks that publish between the check and the subscribe.
            await pubsub.subscribe(channel)
            logger.info(f"SSE client subscribed to {channel}")

            # Check whether ClickHouse already has a root span with an end time.
            # That starts the quiet window, but it does not immediately close the
            # stream: distributed traces can still receive descendant spans after
            # the root wrapper has finished.
            root_end_time, last_ingest_time = await asyncio.to_thread(
                _completion_state_in_clickhouse, project_id, trace_id
            )

            completion_deadline = None
            if root_end_time is not None:
                # Anchor the quiet window to the LATEST of root end and last
                # span ingest: an old idle trace closes immediately instead of
                # holding the SSE connection and Redis subscription for the
                # full window, while a trace whose descendants are still
                # arriving (root ended early) keeps its late-span protection.
                # ClickHouse stores naive UTC timestamps; clamp age at 0
                # against clock skew.
                anchor = max(root_end_time, last_ingest_time or root_end_time)
                now_utc = datetime.now(UTC).replace(tzinfo=None)
                age = max(0.0, (now_utc - anchor).total_seconds())
                completion_deadline = time.monotonic() + max(
                    0.0, TRACE_COMPLETE_QUIET_SECONDS - age
                )

            # Live trace: stream until a completion candidate remains quiet long
            # enough, or until the hard timeout.
            deadline = time.monotonic() + MAX_STREAM_SECONDS

            while time.monotonic() < deadline:
                if await request.is_disconnected():
                    break

                now = time.monotonic()
                if completion_deadline is not None:
                    quiet_remaining = completion_deadline - now
                    if quiet_remaining <= 0:
                        yield "event: trace_complete\ndata: {}\n\n"
                        return
                    timeout = min(HEARTBEAT_INTERVAL, quiet_remaining)
                else:
                    timeout = HEARTBEAT_INTERVAL

                message = await pubsub.get_message(
                    ignore_subscribe_messages=True,
                    timeout=timeout,
                )

                if message is not None and message["type"] == "message":
                    data = json.loads(message["data"])
                    event_type = data.get("type", "spans")

                    if event_type == "trace_complete":
                        completion_deadline = time.monotonic() + TRACE_COMPLETE_QUIET_SECONDS
                        continue

                    yield f"event: {event_type}\ndata: {message['data']}\n\n"

                    if event_type == "spans" and completion_deadline is not None:
                        completion_deadline = time.monotonic() + TRACE_COMPLETE_QUIET_SECONDS
                else:
                    if completion_deadline is not None and time.monotonic() >= completion_deadline:
                        yield "event: trace_complete\ndata: {}\n\n"
                        return
                    yield ": heartbeat\n\n"
            else:
                if completion_deadline is not None:
                    # A completed root kept the quiet window resetting all the
                    # way to the hard ceiling: the trace is done, so close as
                    # complete — the frontend's completion path refetches.
                    yield "event: trace_complete\ndata: {}\n\n"
                else:
                    yield "event: stream_timeout\ndata: {}\n\n"

        except asyncio.CancelledError:
            pass
        finally:
            await pubsub.unsubscribe(channel)
            await pubsub.close()
            logger.info(f"SSE client disconnected from {channel}")

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )
