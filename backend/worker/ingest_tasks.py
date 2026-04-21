"""Celery task definitions.

This module defines the async tasks that process trace data from S3 to ClickHouse.
"""

import json
import logging
from collections import defaultdict
from datetime import datetime

from worker.celery_app import app

logger = logging.getLogger(__name__)


def _json_serializer(obj: object) -> str:
    """JSON serializer for datetime objects in span dicts."""
    if isinstance(obj, datetime):
        return obj.isoformat()
    raise TypeError(f"Object of type {type(obj)} is not JSON serializable")


def _publish_live_spans(spans: list[dict], project_id: str) -> None:
    """Publish spans to Redis for live trace streaming.

    Groups spans by trace_id and publishes to per-trace channels.
    Never raises — Redis failures must not break the ingest pipeline.
    """
    try:
        import redis as redis_lib

        from shared.config import settings

        # Create a fresh Redis connection per call — do NOT use the singleton
        # get_redis_client() here because Celery uses prefork and module-level
        # singletons created before/across fork() crash on macOS (SIGABRT).
        redis_client = redis_lib.from_url(settings.redis.url, decode_responses=True)

        # Group spans by trace_id
        by_trace: dict[str, list[dict]] = defaultdict(list)
        for span in spans:
            by_trace[span["trace_id"]].append(span)

        for trace_id, trace_spans in by_trace.items():
            channel = f"trace:live:{project_id}:{trace_id}"

            # Publish spans
            payload = json.dumps(
                {"type": "spans", "spans": trace_spans},
                default=_json_serializer,
            )
            redis_client.publish(channel, payload)

            # Check if trace is complete (root span with end time)
            for span in trace_spans:
                if span.get("parent_span_id") is None and span.get("span_end_time") is not None:
                    redis_client.publish(
                        channel,
                        json.dumps({"type": "trace_complete"}),
                    )
                    break

        redis_client.close()

    except Exception:
        logger.warning("Failed to publish live spans to Redis", exc_info=True)


@app.task(
    bind=True,
    autoretry_for=(Exception,),
    retry_backoff=True,
    retry_backoff_max=600,  # Max 10 minutes between retries
    max_retries=5,
)
def process_s3_traces(self, s3_key: str, project_id: str) -> dict:
    """Process OTEL traces from S3 and insert into ClickHouse.

    This task:
    1. Downloads the OTEL JSON from S3
    2. Transforms it to ClickHouse format
    3. Batch inserts traces and spans

    Args:
        s3_key: S3 key where the OTEL JSON is stored
        project_id: Project ID for the traces

    Returns:
        Dict with counts of inserted traces and spans
    """
    # Import here to avoid circular imports and ensure fresh connections
    from db.clickhouse.client import get_clickhouse_client
    from rest.services.s3 import get_s3_service
    from worker.otel_transform import transform_otel_to_clickhouse

    logger.info(f"Processing S3 traces: {s3_key} for project {project_id}")

    try:
        # 1. Download from S3
        s3_service = get_s3_service()
        otel_data = s3_service.download_json(s3_key)
        logger.debug(f"Downloaded OTEL data from {s3_key}")

        # 2. Transform to ClickHouse format
        traces, spans = transform_otel_to_clickhouse(otel_data, project_id)
        logger.info(f"Transformed {len(traces)} traces and {len(spans)} spans from {s3_key}")

        # 3. Insert into ClickHouse
        if traces or spans:
            ch_client = get_clickhouse_client()

            if traces:
                # Only insert a trace record if this batch contains the root span
                # OR the trace is genuinely new (no existing ClickHouse record).
                # Intermediate batches without the root span must not overwrite a
                # correctly-named trace record with a wrong name.
                traces_with_root = {s["trace_id"] for s in spans if s.get("parent_span_id") is None}
                traces_without_root = [t for t in traces if t["trace_id"] not in traces_with_root]
                if traces_without_root:
                    ids = [t["trace_id"] for t in traces_without_root]
                    result = ch_client.query(
                        "SELECT DISTINCT trace_id FROM traces FINAL"
                        " WHERE trace_id IN {ids:Array(String)}",
                        parameters={"ids": ids},
                    )
                    existing_ids = {row[0] for row in result.result_rows}
                    traces = [
                        t
                        for t in traces
                        if t["trace_id"] in traces_with_root or t["trace_id"] not in existing_ids
                    ]

                if traces:
                    ch_client.insert_traces_batch(traces)
                    logger.info(f"Inserted {len(traces)} traces into ClickHouse")

            if spans:
                ch_client.insert_spans_batch(spans)
                logger.info(f"Inserted {len(spans)} spans into ClickHouse")

        # 4. Publish to Redis for live trace streaming
        if spans:
            _publish_live_spans(spans, project_id)

        return {
            "s3_key": s3_key,
            "project_id": project_id,
            "traces": len(traces),
            "spans": len(spans),
        }

    except Exception as e:
        logger.error(f"Failed to process {s3_key}: {e}", exc_info=True)
        raise  # Re-raise to trigger Celery retry
