"""Bound how often an ingest attempt is redelivered after its worker process dies.

``celery_app`` sets ``task_acks_late`` and ``task_reject_on_worker_lost``. When the worker
child running a task dies (an OOM kill), Celery requeues its message; when the whole worker
dies (its container OOM-killed or SIGKILLed), the broker restores the unacked message after
the visibility timeout. Either way the message comes back flagged ``redelivered``, under
the same task id and retry number, and nothing counts that. So a batch that kills its
process every time never reaches ``max_retries`` or the task's ``on_failure`` (which
quarantines it, see ``ingest_quarantine``): it is redelivered until its staged object
expires (``events/ingest/``, 7 days), and is then lost.

``check_redelivery`` counts the redeliveries of one attempt, under
``ingest:deliveries:<task id>:<retry number>`` in the broker's Redis, before the task does
any work; a first delivery touches nothing. ``clear_delivery`` drops the count when the
delivery ends in its own process, so a count is left only by a delivery whose process died
or one that was refused. Past ``INGEST_MAX_DELIVERIES`` deliveries of an attempt, the next
raises ``RedeliveryLimitError``, which fails the attempt like any other error: it is retried
with the task's backoff, as a new attempt with a count of its own, and quarantined by
``on_failure`` when the retries run out. A batch that kills every process it runs in so
kills at most ``(max_retries + 1) * INGEST_MAX_DELIVERIES`` of them (18 by default).

The count is of deaths, not their cause: a batch the OOM killer picked while another held
the memory counts the same. Retrying instead of quarantining at once gives such a batch
only the backoff's few seconds (about 15 s over all the retries on average, 31 s at most)
to find the memory free.

This is a best-effort bound, not a guarantee; ``check_redelivery`` lists what it does not
cover. It never stops a batch it could not count: if Redis refuses the count, the delivery
runs as it did before this guard existed.
"""

from __future__ import annotations

import logging
from typing import Any

logger = logging.getLogger(__name__)

KEY_PREFIX = "ingest:deliveries:"

#: How long a count outlives the delivery that left it: the staged batch's own lifetime
#: (``events/ingest/`` expires after 7 days), so a count never expires before the batch it
#: guards. Only lost and refused attempts leave a key, a few bytes each.
TTL_SECONDS = 7 * 24 * 60 * 60


class RedeliveryLimitError(Exception):
    """An attempt kept losing its worker process and was refused another delivery."""


def _build_counter():
    try:
        from opentelemetry import metrics

        return metrics.get_meter("traceroot.worker.ingest").create_counter(
            "ingest.batch_redeliveries_refused",
            unit="1",
            description=(
                "Ingest deliveries refused because their attempt's worker process kept"
                " dying (INGEST_MAX_DELIVERIES)."
            ),
        )
    except Exception:  # pragma: no cover - metrics are best-effort
        return None


_refused_counter = _build_counter()


def _connect():
    """A client for the broker's Redis. Only redeliveries reach here, so it is not pooled."""
    import redis

    from shared.config import settings

    return redis.Redis.from_url(settings.redis.url, socket_connect_timeout=2, socket_timeout=2)


def delivery_key(task_id: str, retries: int) -> str:
    return f"{KEY_PREFIX}{task_id}:{retries}"


def _attempt_key(request: Any) -> str | None:
    """The redelivered attempt's key, or None for a first delivery or a direct call."""
    task_id = getattr(request, "id", None)
    delivery_info = getattr(request, "delivery_info", None) or {}
    if not task_id or not delivery_info.get("redelivered"):
        return None
    return delivery_key(task_id, int(getattr(request, "retries", 0) or 0))


def check_redelivery(
    request: Any, s3_key: str, *, client: Any = None, limit: int | None = None
) -> bool:
    """Count this delivery if it is a redelivery; refuse it past the limit.

    Not covered, so the bound is best effort: a delivery Redis refuses to count (it runs);
    a process that dies after its delivery cleared the count but before the worker acked
    the message (its redelivery starts a new count); and a count evicted or lost with a
    Redis that kept the message.

    Counted early, so a healthy attempt can be refused (it is then retried): a message
    restored before it ever ran, as at a worker's shutdown, comes back flagged and counts
    one delivery early; and a delivery that outlives the visibility timeout (an hour) is
    restored and run again while it still runs, each restored copy counting until one of
    them finishes and clears the count.

    Args:
        request: The task's ``self.request``.
        s3_key: The batch, for the log line.
        client: A Redis client; a connection to the broker's by default.
        limit: Deliveries allowed per attempt; ``settings.ingest.max_deliveries`` by default.

    Returns:
        bool: True if this delivery was counted, so the caller clears it when it ends.

    Raises:
        RedeliveryLimitError: This delivery would exceed the limit.
    """
    key = _attempt_key(request)
    if key is None:
        return False
    redis = client
    try:
        redis = redis if redis is not None else _connect()
        pipe = redis.pipeline()  # MULTI/EXEC: the count and its expiry land together
        pipe.incr(key)
        pipe.expire(key, TTL_SECONDS)
        redeliveries = int(pipe.execute()[0])
    except Exception:
        logger.warning(
            "Could not count the redeliveries of %s; processing it without the limit",
            s3_key,
            exc_info=True,
        )
        return False
    finally:
        if client is None and redis is not None:
            redis.close()
    if limit is None:
        from shared.config import settings

        limit = settings.ingest.max_deliveries
    deliveries = redeliveries + 1  # and the first delivery, which is not counted
    if deliveries <= limit:
        return True
    if _refused_counter is not None:
        try:
            _refused_counter.add(1, {})
        except Exception:  # pragma: no cover - best-effort metric
            logger.debug("failed to record the redelivery counter", exc_info=True)
    logger.error(
        "Batch %s reached delivery %d with its worker process lost on each one before"
        " (INGEST_MAX_DELIVERIES=%d); refusing it, which fails this attempt",
        s3_key,
        deliveries,
        limit,
    )
    raise RedeliveryLimitError(
        f"delivery {deliveries} of an attempt whose worker process kept dying"
        f" (INGEST_MAX_DELIVERIES={limit})"
    )


def clear_delivery(request: Any, *, client: Any = None) -> None:
    """Forget the attempt's count: this delivery ended in its own process."""
    key = _attempt_key(request)
    if key is None:
        return
    redis = client
    try:
        redis = redis if redis is not None else _connect()
        redis.delete(key)
    except Exception:
        logger.debug("Could not clear %s", key, exc_info=True)
    finally:
        if client is None and redis is not None:
            redis.close()
