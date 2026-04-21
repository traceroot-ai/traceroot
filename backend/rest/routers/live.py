"""Live trace streaming via Server-Sent Events (SSE).

Subscribes to a Redis pub/sub channel for a specific trace and streams
span updates to the client in real time.
"""

import asyncio
import json
import logging
import time

from fastapi import APIRouter, Request
from starlette.responses import StreamingResponse

from rest.routers.deps import ProjectAccess

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/projects/{project_id}/traces/{trace_id}", tags=["Live"])

HEARTBEAT_INTERVAL = 15  # seconds
MAX_STREAM_SECONDS = 600  # 10 minutes — hard ceiling for idle connections


def _is_trace_complete_in_clickhouse(project_id: str, trace_id: str) -> bool:
    """Return True if ClickHouse has a root span (no parent) with an end_time for this trace."""
    from db.clickhouse.client import get_clickhouse_client

    ch_client = get_clickhouse_client()
    result = ch_client.query(
        """
        SELECT count() FROM spans FINAL
        WHERE project_id = {project_id:String}
          AND trace_id   = {trace_id:String}
          AND isNull(parent_span_id)
          AND isNotNull(span_end_time)
        """,
        parameters={"project_id": project_id, "trace_id": trace_id},
    )
    return result.result_rows[0][0] > 0


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
    - `event: trace_complete` when the root span finishes
    - Heartbeat comments every 15s to keep the connection alive

    For traces that are already complete when the client connects, this
    endpoint detects that via ClickHouse and emits trace_complete immediately,
    after forwarding any span events that arrived on Redis concurrently.
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

            # Check whether the trace is already done in ClickHouse.
            already_complete = await asyncio.to_thread(
                _is_trace_complete_in_clickhouse, project_id, trace_id
            )

            if already_complete:
                # Forward any span events that were published to Redis while we
                # were doing the ClickHouse check (concurrent Celery tasks).
                # These spans are guaranteed to be in ClickHouse already because
                # process_s3_traces always writes to ClickHouse before publishing
                # to Redis.
                while True:
                    msg = await pubsub.get_message(ignore_subscribe_messages=True, timeout=0)
                    if msg is None:
                        break
                    if msg["type"] == "message":
                        data = json.loads(msg["data"])
                        if data.get("type") == "spans":
                            yield f"event: spans\ndata: {msg['data']}\n\n"

                yield "event: trace_complete\ndata: {}\n\n"
                return

            # Live trace: stream normally until trace_complete or timeout.
            deadline = time.monotonic() + MAX_STREAM_SECONDS

            while time.monotonic() < deadline:
                if await request.is_disconnected():
                    break

                message = await pubsub.get_message(
                    ignore_subscribe_messages=True,
                    timeout=HEARTBEAT_INTERVAL,
                )

                if message is not None and message["type"] == "message":
                    data = json.loads(message["data"])
                    event_type = data.get("type", "spans")

                    yield f"event: {event_type}\ndata: {message['data']}\n\n"

                    if event_type == "trace_complete":
                        break
                else:
                    yield ": heartbeat\n\n"
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
