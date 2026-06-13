"""
Detector trigger evaluation and BullMQ enqueue.

Called from process_s3_traces after ClickHouse insert.
Non-blocking: exceptions are caught and logged, never re-raised.

Exactly-once triggering: the ingest batch carrying a trace's root span claims
the trace via a Redis lock, evaluates trigger conditions plus deterministic
sampling, and enqueues a single delayed BullMQ job (the delay is a settle
window — the worker re-checks trace completeness at execution time). Later
batches for an already-claimed trace only feed a bounded re-evaluation check:
at most one re-eval, when the span count grew after evaluation.
"""

import asyncio
import hashlib
import json
import logging
import uuid

logger = logging.getLogger(__name__)

# BullMQ queue name — must match TypeScript DETECTOR_RUN_QUEUE constant
DETECTOR_RUN_QUEUE = "detector-run"

# Lock TTL. After expiry a late batch is simply ignored by the re-eval check;
# detection itself only ever fires from the root-bearing batch.
_LOCK_TTL_SECONDS = 3600

# Settle window before the worker evaluates the trace.
_DETECT_DELAY_MS = 60_000

# Token-checked release: delete the lock only when it still holds the exact
# value this attempt wrote, so a failing attempt can never delete state
# written by a successor (which would break exactly-once).
_RELEASE_IF_VALUE_LUA = """
if redis.call('GET', KEYS[1]) == ARGV[1] then
    return redis.call('DEL', KEYS[1])
end
return 0
"""


def _get_redis():
    """Get Redis client using same connection as Celery broker."""
    import redis

    from worker.celery_app import app as celery_app

    return redis.from_url(celery_app.conf.broker_url)


def _lock_key(project_id: str, trace_id: str) -> str:
    return f"detector-enq:{project_id}:{trace_id}"


def _release_lock_if_value(redis_client, key: str, expected: str) -> None:
    redis_client.eval(_RELEASE_IF_VALUE_LUA, 1, key, expected)


def _sample_passes(trace_id: str, detector_id: str, sample_rate: float) -> bool:
    """Deterministic per-(trace, detector) sampling decision.

    Hash-based rather than random.random() so the decision is idempotent
    across batches and Celery retries — a replay can never re-roll the dice.
    """
    digest = hashlib.sha256(f"{trace_id}:{detector_id}".encode()).digest()
    return int.from_bytes(digest[:8], "big") / 2**64 < sample_rate / 100.0


def _add_bullmq_job(job_id: str, data: dict) -> None:
    """Add a delayed job via the official BullMQ client (jobId gives dedup).

    bullmq's API is asyncio; this runs from Celery task context where no loop
    is running, so wrap the add in asyncio.run().
    """
    from bullmq import Queue

    from worker.celery_app import app as celery_app

    async def _add() -> None:
        queue = Queue(DETECTOR_RUN_QUEUE, {"connection": celery_app.conf.broker_url})
        try:
            await queue.add(
                "detect",
                data,
                {
                    "jobId": job_id,
                    "delay": _DETECT_DELAY_MS,
                    "attempts": 3,
                    "removeOnComplete": 100,
                    "removeOnFail": 50,
                },
            )
        finally:
            await queue.close()

    asyncio.run(_add())


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
    Returns {trace_id: {environment}}
    """
    from db.clickhouse.client import get_clickhouse_client

    if not trace_ids:
        return {}

    ch = get_clickhouse_client()

    result = ch.query(
        """
        SELECT
            trace_id,
            anyIf(environment, parent_span_id IS NULL) AS environment
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
            "environment": row[1],  # Nullable — None if not set
        }
    return summaries


def _get_trace_span_counts(project_id: str, trace_ids: list[str]) -> dict[str, int]:
    """Query ClickHouse for the current span count of each trace."""
    from db.clickhouse.client import get_clickhouse_client

    if not trace_ids:
        return {}

    ch = get_clickhouse_client()

    # FINAL so this count matches the deduped span_count the worker stored
    # (from the spans-jsonl FINAL query); without it a pre-merge duplicate row
    # could read as growth and fire a spurious re-eval.
    result = ch.query(
        """
        SELECT trace_id, count() AS span_count
        FROM spans FINAL
        WHERE project_id = {project_id:String}
          AND trace_id IN {trace_ids:Array(String)}
        GROUP BY trace_id
        """,
        parameters={"project_id": project_id, "trace_ids": trace_ids},
    )

    return {row[0]: int(row[1]) for row in result.result_rows}


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


def _claim_and_enqueue(
    redis_client,
    project_id: str,
    trace_id: str,
    detectors: list[dict],
    summary: dict,
) -> None:
    """Root-bearing batch: claim the trace and enqueue at most one detection job."""
    key = _lock_key(project_id, trace_id)
    token = uuid.uuid4().hex
    last_written = json.dumps({"state": "deciding", "token": token})

    # NX claim: loses against ingest-task retry replay, duplicate root
    # delivery, or a concurrent batch — exactly-once holds either way.
    if not redis_client.set(key, last_written, nx=True, ex=_LOCK_TTL_SECONDS):
        logger.debug(f"Detector enqueue already claimed for trace {trace_id}; skipping")
        return

    try:
        triggered_ids = [
            d["id"]
            for d in detectors
            if _passes_trigger(summary, d["conditions"])
            and _sample_passes(trace_id, d["id"], d["sample_rate"])
        ]

        if not triggered_ids:
            # Sticky no: a replay must not re-roll conditions or sampling.
            redis_client.set(
                key,
                json.dumps({"state": "sampled_out", "token": token}),
                ex=_LOCK_TTL_SECONDS,
            )
            return

        _add_bullmq_job(
            f"{project_id}--{trace_id}",
            {
                "traceId": trace_id,
                "detectorIds": triggered_ids,
                "projectId": project_id,
                "reeval": False,
            },
        )
        redis_client.set(
            key,
            json.dumps({"state": "pending", "detector_ids": triggered_ids, "token": token}),
            ex=_LOCK_TTL_SECONDS,
        )
        logger.debug(f"Enqueued detector run: trace={trace_id} detectors={triggered_ids}")
    except Exception:
        # Release only the value this attempt wrote so a later batch or retry
        # can re-claim; a BullMQ job that was already added dedups by jobId.
        _release_lock_if_value(redis_client, key, last_written)
        raise


def _check_reevals(redis_client, project_id: str, trace_ids: list[str]) -> None:
    """Late batches for already-claimed traces: allow at most one re-eval.

    Only traces the worker marked "evaluated" (with reevals still 0) qualify,
    and only when their span count grew since evaluation.
    """
    candidates: dict[str, dict] = {}
    for trace_id in trace_ids:
        try:
            raw = redis_client.get(_lock_key(project_id, trace_id))
            if raw is None:
                # Trace predates the lock scheme or the TTL expired.
                continue
            state = json.loads(raw)
            if state.get("state") == "evaluated" and state.get("reevals", 0) == 0:
                candidates[trace_id] = state
        except Exception as trace_err:
            logger.error(
                f"Failed re-eval lock check for trace {trace_id}: {trace_err}",
                exc_info=True,
            )

    if not candidates:
        return

    counts = _get_trace_span_counts(project_id, list(candidates))
    for trace_id, state in candidates.items():
        try:
            old_count = int(state.get("span_count") or 0)
            new_count = counts.get(trace_id, 0)
            if new_count <= old_count:
                continue

            detector_ids = state.get("detector_ids") or []
            redis_client.set(
                _lock_key(project_id, trace_id),
                json.dumps(
                    {
                        "state": "reevaluating",
                        "detector_ids": detector_ids,
                        "span_count": new_count,
                        "reevals": 1,
                    }
                ),
                ex=_LOCK_TTL_SECONDS,
            )
            _add_bullmq_job(
                f"{project_id}--{trace_id}--r1",
                {
                    "traceId": trace_id,
                    "detectorIds": detector_ids,
                    "projectId": project_id,
                    "reeval": True,
                },
            )
            logger.info(
                f"Enqueued detector re-eval for trace {trace_id}: "
                f"span count {old_count} -> {new_count}"
            )
        except Exception as trace_err:
            logger.error(
                f"Failed to enqueue detector re-eval for trace {trace_id}: {trace_err}",
                exc_info=True,
            )


def enqueue_detector_runs(
    project_id: str, trace_ids: list[str], traces_with_root: set[str]
) -> None:
    """
    Called after trace ingestion. Traces whose root span arrived in this batch
    are claimed and (conditions + sampling permitting) enqueued for detection;
    the remaining trace IDs only feed the bounded re-eval check.

    This function is intentionally non-raising — detector failures must not
    break trace ingestion.
    """
    if not trace_ids:
        return

    try:
        redis_client = _get_redis()
        root_traces = [t for t in trace_ids if t in traces_with_root]
        late_traces = [t for t in trace_ids if t not in traces_with_root]

        if root_traces:
            detectors = _get_active_detectors(project_id)
            summaries = _get_trace_summaries(project_id, root_traces) if detectors else {}
            for trace_id in root_traces:
                # Per-trace try/except so a malformed condition (e.g. non-numeric
                # `value` for a `>` op causing float() to ValueError, or a None
                # sample_rate) only drops the offending trace — remaining traces
                # in the batch still get enqueued.
                try:
                    _claim_and_enqueue(
                        redis_client,
                        project_id,
                        trace_id,
                        detectors,
                        summaries.get(trace_id, {}),
                    )
                except Exception as trace_err:
                    logger.error(
                        f"Failed to enqueue detector run for trace {trace_id}: {trace_err}",
                        exc_info=True,
                    )

        if late_traces:
            _check_reevals(redis_client, project_id, late_traces)

    except Exception as e:
        # Non-blocking: log and return, never raise
        logger.error(
            f"Failed to enqueue detector runs for project {project_id}: {e}",
            exc_info=True,
        )
