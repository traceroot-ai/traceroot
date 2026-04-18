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
    """

    async def event_generator():
        from shared.redis import get_async_redis_client

        redis_client = get_async_redis_client()
        pubsub = redis_client.pubsub()
        channel = f"trace:live:{project_id}:{trace_id}"

        try:
            await pubsub.subscribe(channel)
            logger.info(f"SSE client subscribed to {channel}")
            deadline = time.monotonic() + MAX_STREAM_SECONDS

            while time.monotonic() < deadline:
                # Check if client disconnected
                if await request.is_disconnected():
                    break

                # Poll for messages with a timeout (enables heartbeat + disconnect check)
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
                    # No message within timeout — send heartbeat
                    yield ": heartbeat\n\n"
            else:
                # Deadline reached — close the stream
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
