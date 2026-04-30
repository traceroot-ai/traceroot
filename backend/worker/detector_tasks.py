"""
Detector trigger evaluation and BullMQ enqueue.

Called from process_s3_traces after ClickHouse insert.
Non-blocking: exceptions are caught and logged, never re-raised.
"""

import json
import logging
import random
import time

logger = logging.getLogger(__name__)

# BullMQ queue name — must match TypeScript DETECTOR_RUN_QUEUE constant
DETECTOR_RUN_QUEUE = "detector-run"


def _get_redis():
    """Get Redis client using same connection as Celery broker."""
    import redis

    from worker.celery_app import app as celery_app

    return redis.from_url(celery_app.conf.broker_url)


def _eval_condition(trace_summary: dict, condition: dict) -> bool:
    """Evaluate a single trigger condition against a trace summary dict."""
    field = condition.get("field")
    op = condition.get("op")
    value = condition.get("value")

    actual = trace_summary.get(field)
    # For != conditions, a missing/null field counts as "not equal"
    if actual is None:
        return op == "!="

    if op == "=":
        return actual == value
    elif op == "!=":
        return actual != value
    elif op == ">":
        return float(actual) > float(value)
    elif op == ">=":
        return float(actual) >= float(value)
    elif op == "<":
        return float(actual) < float(value)
    elif op == "<=":
        return float(actual) <= float(value)
    return False


def _passes_trigger(trace_summary: dict, conditions: list[dict]) -> bool:
    """All conditions must pass (AND logic). Empty conditions list = always passes."""
    return all(_eval_condition(trace_summary, c) for c in conditions)


def _get_trace_summaries(project_id: str, trace_ids: list[str]) -> dict[str, dict]:
    """
    Query ClickHouse for the fields needed for trigger evaluation.
    Returns {trace_id: {root_span_finished, status, environment}}
    """
    from db.clickhouse.client import get_clickhouse_client

    if not trace_ids:
        return {}

    ch = get_clickhouse_client()

    result = ch.query(
        """
        SELECT
            trace_id,
            max(CASE WHEN parent_span_id IS NULL THEN 1 ELSE 0 END) AS root_span_finished,
            max(CASE WHEN status = 'ERROR' THEN 1 ELSE 0 END)       AS has_error,
            anyIf(environment, parent_span_id IS NULL)               AS environment
        FROM spans
        WHERE project_id = {project_id:String}
          AND trace_id IN {trace_ids:Array(String)}
        GROUP BY trace_id
        """,
        parameters={"project_id": project_id, "trace_ids": trace_ids},
    )

    summaries: dict[str, dict] = {}
    for row in result.result_rows:
        summaries[row[0]] = {
            "root_span_finished": bool(row[1]),
            # Expose status as a string matching what users configure ("ERROR" or "OK")
            "status": "ERROR" if bool(row[2]) else "OK",
            "environment": row[3],  # Nullable — None if not set
        }
    return summaries


def _get_active_detectors(project_id: str) -> list[dict]:
    """
    Fetch active detectors and their trigger conditions from PostgreSQL using psycopg2.
    Returns list of dicts with keys: id, sample_rate, conditions.
    """
    import psycopg2

    from shared.config import settings

    conn = psycopg2.connect(settings.database_url)
    try:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT d.id, d.sample_rate, dt.conditions
                FROM detectors d
                LEFT JOIN detector_triggers dt ON dt.detector_id = d.id
                WHERE d.project_id = %s AND d.enabled = TRUE
                """,
                (project_id,),
            )
            rows = cur.fetchall()
    finally:
        conn.close()

    detectors = []
    for detector_id, sample_rate, conditions in rows:
        # conditions is a JSON field; psycopg2 may return dict or None
        if conditions is None:
            cond_list = []
        elif isinstance(conditions, list):
            cond_list = conditions
        elif isinstance(conditions, str):
            cond_list = json.loads(conditions)
        else:
            # Already parsed by psycopg2 (dict/list from JSONB)
            cond_list = conditions if isinstance(conditions, list) else []

        detectors.append(
            {
                "id": detector_id,
                "sample_rate": sample_rate,
                "conditions": cond_list,
            }
        )
    return detectors


def _enqueue_to_bullmq(redis_client, queue_name: str, job_id: str, data: dict) -> None:
    """
    Enqueue a job to a BullMQ queue via Redis.

    BullMQ v4+ format:
    - Job fields are stored in a Redis hash at bull:{queue}:{jobId}
    - Only the job ID string is pushed to the bull:{queue}:wait list
    This matches how BullMQ's Queue.add() works internally.
    """
    timestamp_ms = int(time.time() * 1000)
    job_hash_key = f"bull:{queue_name}:{job_id}"

    redis_client.hset(
        job_hash_key,
        mapping={
            "name": "detect",
            "data": json.dumps(data),
            "opts": json.dumps(
                {
                    "jobId": job_id,
                    "removeOnComplete": 100,
                    "removeOnFail": 50,
                    "attempts": 3,
                }
            ),
            "timestamp": str(timestamp_ms),
            "delay": "0",
            "priority": "0",
            "attempts": "0",
        },
    )
    # Push job ID (not the full payload) to the wait list
    redis_client.rpush(f"bull:{queue_name}:wait", job_id)


def enqueue_detector_runs(project_id: str, trace_ids: list[str]) -> None:
    """
    Called after trace ingestion. For each active detector in this project,
    evaluate trigger conditions and enqueue eligible traces to BullMQ.

    This function is intentionally non-raising — detector failures must not
    break trace ingestion.
    """
    if not trace_ids:
        return

    try:
        detectors = _get_active_detectors(project_id)

        if not detectors:
            return

        summaries = _get_trace_summaries(project_id, trace_ids)
        redis_client = _get_redis()

        # Group triggered detectors per trace so we enqueue ONE job per trace
        # carrying the complete detector set. The TS worker can then run all
        # detector evals for a trace in parallel and produce exactly one finding.
        for trace_id in trace_ids:
            # Per-trace try/except so a malformed condition (e.g. non-numeric
            # `value` for a `>` op causing float() to ValueError, or a None
            # sample_rate) only drops the offending trace — remaining traces
            # in the batch still get enqueued.
            try:
                summary = summaries.get(trace_id, {})

                # Hardcoded gate: never fire on incomplete traces (root span must exist)
                if not summary.get("root_span_finished"):
                    continue

                triggered_ids: list[str] = []
                for detector in detectors:
                    if not _passes_trigger(summary, detector["conditions"]):
                        continue
                    if random.random() > detector["sample_rate"] / 100.0:
                        continue
                    triggered_ids.append(detector["id"])

                if not triggered_ids:
                    continue

                job_id = f"{project_id}--{trace_id}"
                _enqueue_to_bullmq(
                    redis_client,
                    DETECTOR_RUN_QUEUE,
                    job_id,
                    {
                        "traceId": trace_id,
                        "detectorIds": triggered_ids,
                        "projectId": project_id,
                    },
                )
                logger.debug(f"Enqueued detector run: trace={trace_id} detectors={triggered_ids}")
            except Exception as trace_err:
                logger.error(
                    f"Failed to enqueue detector run for trace {trace_id}: {trace_err}",
                    exc_info=True,
                )

    except Exception as e:
        # Non-blocking: log and return, never raise
        logger.error(
            f"Failed to enqueue detector runs for project {project_id}: {e}",
            exc_info=True,
        )
