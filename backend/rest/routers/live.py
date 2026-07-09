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

from rest.routers.deps import ProjectAccess
from shared.config import settings

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/projects/{project_id}/traces/{trace_id}", tags=["Live"])

HEARTBEAT_INTERVAL = 15  # seconds
MAX_STREAM_SECONDS = 600  # 10 minutes — hard ceiling for idle connections
# Read once from settings so tests can still patch the module constant. Kept
# above the SDK's 5s default flush interval so a quiet window can't expire
# between two batches of the same live trace.
TRACE_COMPLETE_QUIET_SECONDS = settings.trace_complete_quiet_seconds


def _root_completion_time_in_clickhouse(project_id: str, trace_id: str) -> datetime | None:
    """Return the end time of this trace's root span, or None if still open.

    A root span with an end time is a completion candidate, not proof that no
    more descendant spans can arrive. Some streaming handlers finish the root
    span before background work emits its children.
    """
    from db.clickhouse.client import get_clickhouse_client

    ch_client = get_clickhouse_client()
    result = ch_client.query(
        """
        SELECT max(span_end_time) FROM spans FINAL
        WHERE project_id = {project_id:String}
          AND trace_id   = {trace_id:String}
          AND isNull(parent_span_id)
          AND isNotNull(span_end_time)
        """,
        parameters={"project_id": project_id, "trace_id": trace_id},
    )
    rows = result.result_rows
    return rows[0][0] if rows and rows[0][0] is not None else None


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
            root_end_time = await asyncio.to_thread(
                _root_completion_time_in_clickhouse, project_id, trace_id
            )

            completion_deadline = None
            if root_end_time is not None:
                # Anchor the quiet window to when the root actually ended, so
                # opening an old completed trace doesn't hold the SSE connection
                # and Redis subscription for the full window. ClickHouse stores
                # naive UTC timestamps; clamp age at 0 against clock skew.
                now_utc = datetime.now(UTC).replace(tzinfo=None)
                age = max(0.0, (now_utc - root_end_time).total_seconds())
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
                # Hard ceiling reached. Emit trace_complete rather than a
                # timeout event: the frontend's completion path closes the
                # stream and refetches, which leaves the client with correct
                # data instead of a silently stale live view.
                yield "event: trace_complete\ndata: {}\n\n"

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
