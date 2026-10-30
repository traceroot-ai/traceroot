"""Quarantine for ingest batches that failed every processing attempt.

A batch whose last attempt fails would otherwise stay under ``events/otel/``
until that prefix expires, leaving only an error log behind. Moving it
to ``events/failed/`` keeps it under a separate, longer retention so it can be
inspected or replayed, and the counters below record that it happened.

The move is copy-then-delete: the original is deleted only after the copy
succeeded, so a failure at any step leaves at least one copy of the batch.
"""

import logging

logger = logging.getLogger(__name__)

INGEST_PREFIX = "events/otel/"
FAILED_PREFIX = "events/failed/"


# --- OpenTelemetry counters (no-op until a MeterProvider is configured) ------
# Same approach as the REST rate limiter: instrument with the metrics API only
# and keep a log line next to every increment, so the event is visible even
# before a provider exists.
def _build_counters():
    try:
        from opentelemetry import metrics

        meter = metrics.get_meter("traceroot.worker.ingest")
        quarantined = meter.create_counter(
            "ingest.batches_quarantined",
            unit="1",
            description="Ingest batches copied to events/failed/ after their final attempt.",
        )
        failed = meter.create_counter(
            "ingest.batch_quarantine_failed",
            unit="1",
            description="Errors while quarantining an ingest batch, by stage (copy or delete).",
        )
        return quarantined, failed
    except Exception:  # pragma: no cover - metrics are best-effort
        return None, None


_quarantined_counter, _quarantine_failed_counter = _build_counters()


def _count(counter, attributes: dict[str, str] | None = None) -> None:
    if counter is None:
        return
    try:
        counter.add(1, attributes or {})
    except Exception:  # pragma: no cover - best-effort metric
        logger.debug("failed to record ingest quarantine counter", exc_info=True)


def failed_key_for(s3_key: str) -> str | None:
    """Return the ``events/failed/`` key for an ingest batch key.

    Returns None for a key outside ``events/otel/``, which is never moved.
    """
    if not s3_key.startswith(INGEST_PREFIX):
        return None
    return FAILED_PREFIX + s3_key[len(INGEST_PREFIX) :]


def quarantine_batch(s3_service, s3_key: str) -> bool:
    """Move an ingest batch to ``events/failed/``: copy, then delete the original.

    Never raises. The caller is already handling the batch's own failure and
    must re-raise that, not an error from here.

    - Copy fails: the original is kept, nothing is deleted, and
      ``ingest.batch_quarantine_failed{stage="copy"}`` is counted.
    - Copy succeeds: ``ingest.batches_quarantined`` is counted. If the delete
      then fails, the batch exists under both prefixes until the original
      expires, and ``ingest.batch_quarantine_failed{stage="delete"}``
      is counted too.

    Args:
        s3_service: S3Service holding the batch
        s3_key: Full S3 key of the batch

    Returns:
        True when the batch was copied to ``events/failed/``
    """
    failed_key = failed_key_for(s3_key)
    if failed_key is None:
        logger.warning("Not quarantining %s: key is outside %s", s3_key, INGEST_PREFIX)
        return False

    try:
        s3_service.copy_object(s3_key, failed_key)
    except Exception:
        logger.error(
            "Failed to quarantine %s to %s; the original is kept",
            s3_key,
            failed_key,
            exc_info=True,
        )
        _count(_quarantine_failed_counter, {"stage": "copy"})
        return False

    _count(_quarantined_counter)
    logger.warning("Quarantined %s to %s after its final attempt failed", s3_key, failed_key)

    try:
        s3_service.delete_object(s3_key)
    except Exception:
        logger.error(
            "Quarantined %s to %s but could not delete the original",
            s3_key,
            failed_key,
            exc_info=True,
        )
        _count(_quarantine_failed_counter, {"stage": "delete"})

    return True
