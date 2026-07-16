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


def _update_eval_result_costs(project_id: str, trace_ids: set[str], ch_client) -> None:
    """Denormalize each evaluation trace's total cost onto its EvaluationResult row.

    The SDK doesn't report per-case cost — it lives in the trace as summed provider-usage
    span cost (otel_transform sets `cost` only on LLM leaf spans, so `sum(cost)` over a
    trace is its total, no double count). This lets the runs table read `result.cost`
    directly. Idempotent + self-healing: recomputed on every batch, so late-arriving
    spans update the total; never writes 0 (a cost-less trace leaves `cost` NULL).
    """
    if not trace_ids:
        return
    import psycopg2

    from shared.config import settings

    try:
        conn = psycopg2.connect(settings.database_url)
    except Exception:
        logger.warning("eval cost derivation: no Postgres connection", exc_info=True)
        return
    try:
        with conn.cursor() as cur:
            # Only the batch's trace_ids that are evaluation results — bounded lookup.
            cur.execute(
                "SELECT DISTINCT trace_id FROM evaluation_results "
                "WHERE project_id = %s AND trace_id = ANY(%s)",
                (project_id, list(trace_ids)),
            )
            eval_trace_ids = [r[0] for r in cur.fetchall()]
            if not eval_trace_ids:
                return

            rows = ch_client.query(
                "SELECT trace_id, sum(cost) FROM spans FINAL"
                " WHERE project_id = {pid:String} AND trace_id IN {ids:Array(String)}"
                " AND cost IS NOT NULL GROUP BY trace_id",
                parameters={"pid": project_id, "ids": eval_trace_ids},
            ).result_rows

            for trace_id, total in rows:
                cost = float(total) if total is not None else 0.0
                if cost <= 0:
                    continue
                cur.execute(
                    "UPDATE evaluation_results SET cost = %s, update_time = now()"
                    " WHERE project_id = %s AND trace_id = %s",
                    (cost, project_id, trace_id),
                )
        conn.commit()
    except Exception:
        logger.warning("eval cost derivation failed", exc_info=True)
    finally:
        conn.close()


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

        root_bearing_trace_ids = {s["trace_id"] for s in spans if s.get("parent_span_id") is None}

        # 3. Insert into ClickHouse
        if traces or spans:
            ch_client = get_clickhouse_client()

            if traces:
                # Only insert a trace record if this batch contains the root span
                # OR the trace is genuinely new (no existing ClickHouse record).
                # Intermediate batches without the root span must not overwrite a
                # correctly-named trace record with a wrong name.
                trace_records_missing_root = [
                    t for t in traces if t["trace_id"] not in root_bearing_trace_ids
                ]
                if trace_records_missing_root:
                    ids = [t["trace_id"] for t in trace_records_missing_root]
                    result = ch_client.query(
                        "SELECT DISTINCT trace_id FROM traces FINAL"
                        " WHERE trace_id IN {ids:Array(String)}",
                        parameters={"ids": ids},
                    )
                    existing_ids = {row[0] for row in result.result_rows}
                    traces = [
                        t
                        for t in traces
                        if t["trace_id"] in root_bearing_trace_ids
                        or t["trace_id"] not in existing_ids
                    ]

                if traces:
                    ch_client.insert_traces_batch(traces)
                    logger.info(f"Inserted {len(traces)} traces into ClickHouse")

            if spans:
                ch_client.insert_spans_batch(spans)
                logger.info(f"Inserted {len(spans)} spans into ClickHouse")

                # Denormalize eval-trace cost onto EvaluationResult (runs-table Cost).
                try:
                    _update_eval_result_costs(project_id, {s["trace_id"] for s in spans}, ch_client)
                except Exception as e:
                    logger.error(f"eval cost derivation errored: {e}", exc_info=True)

        # Trigger detector runs (fire-and-forget, non-blocking). The batch that
        # carries a trace's root span triggers detection exactly once — a Redis
        # lock keyed on (project, trace) dedups against ingest-task retries and
        # duplicate root delivery. Batches without the root span are ignored
        # here; the worker waits out the quiescence window before evaluating,
        # so late spans need no enqueue.
        if root_bearing_trace_ids:
            try:
                from worker.detector_tasks import enqueue_detector_runs

                enqueue_detector_runs(project_id, root_bearing_trace_ids)
            except Exception as e:
                logger.error(f"Failed to call detector tasks: {e}", exc_info=True)

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
