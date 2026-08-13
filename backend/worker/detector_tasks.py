"""
Detector trigger evaluation and BullMQ enqueue.

Called from process_s3_traces after ClickHouse insert.
Non-blocking: exceptions are caught and logged, never re-raised.

Exactly-once triggering: the ingest batch carrying a trace's root span claims
the trace via a Redis lock, evaluates trigger conditions plus deterministic
sampling, and enqueues a single delayed BullMQ job. The worker waits until the
trace has been quiet for EVALUATOR_DELAY (no new span) before evaluating, so
later batches need no extra enqueue work.
"""

import asyncio
import hashlib
import json
import logging
import operator
import uuid
from decimal import Decimal

logger = logging.getLogger(__name__)

# BullMQ queue name — must match TypeScript DETECTOR_RUN_QUEUE constant
DETECTOR_RUN_QUEUE = "detector-run"

# Lock TTL for the per-trace enqueue claim. Detection only ever fires from the
# root-bearing batch; the NX lock makes that enqueue exactly-once.
_LOCK_TTL_SECONDS = 3600

# Initial delay on the enqueued job; the worker then waits until the trace has
# been quiet this long (no new span) before evaluating. Must match the
# TypeScript EVALUATOR_DELAY constant.
EVALUATOR_DELAY = 60_000  # ms

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
    """Build the Redis key for the per-trace enqueue claim (the NX dedup marker).

    The key — not its value — is the exactly-once guard: a single ``SET NX`` on
    it decides which batch is allowed to enqueue detection for the trace.

    Args:
        project_id (str): Project that owns the trace.
        trace_id (str): Trace being claimed for enqueue.

    Returns:
        str: The namespaced Redis key for this ``(project, trace)`` claim.
    """
    return f"detector-enq:{project_id}:{trace_id}"


def _release_lock_if_value(redis_client, key: str, expected: str) -> None:
    """Delete the enqueue lock only if it still holds ``expected`` (token-checked release).

    Runs a Lua compare-and-delete (see ``_RELEASE_IF_VALUE_LUA``) so a failing
    attempt only ever clears the value it itself wrote. Without the token check
    a slow failure could delete state a successor batch had already claimed,
    breaking the exactly-once enqueue guarantee.

    Args:
        redis_client (redis.Redis): Redis client connected to the Celery broker.
        key (str): The per-trace lock key from :func:`_lock_key`.
        expected (str): The exact lock value this attempt wrote; the delete is a
            no-op unless the current value still matches it.

    Returns:
        None.
    """
    redis_client.eval(_RELEASE_IF_VALUE_LUA, 1, key, expected)


def _sample_passes(trace_id: str, detector_id: str, sample_rate: float | None) -> bool:
    """Deterministic per-(trace, detector) sampling decision.

    Hash-based rather than random.random() so the decision is idempotent
    across batches and Celery retries — a replay can never re-roll the dice.

    Args:
        trace_id (str): Trace being considered.
        detector_id (str): Detector whose sampling is being rolled.
        sample_rate (float | None): Detector sample rate as a percentage. The
            schema constrains this to an int in 0-100, but it is read straight
            from the DB, so we guard against a missing or out-of-range value
            rather than trust it.

    Returns:
        bool: True if this ``(trace, detector)`` pair falls within the sampled
            fraction, False otherwise.
    """
    # Guard the externally-sourced rate: None / <= 0 never samples, >= 100
    # always samples; only a value strictly inside (0, 100) rolls the hash.
    if sample_rate is None:
        return False
    rate = min(max(sample_rate, 0.0), 100.0)
    if rate <= 0.0:
        return False
    if rate >= 100.0:
        return True
    digest = hashlib.sha256(f"{trace_id}:{detector_id}".encode()).digest()
    return int.from_bytes(digest[:8], "big") / 2**64 < rate / 100.0


def _add_bullmq_job(job_id: str, data: dict) -> None:
    """Enqueue one delayed detection job via the official BullMQ client.

    The ``job_id`` is BullMQ's dedup handle: re-adding the same id is a no-op, so
    a replayed enqueue can never create a second job for the trace. bullmq's API
    is asyncio while this runs from synchronous Celery task context with no
    running loop, so the add is wrapped in ``asyncio.run()``.

    Args:
        job_id (str): Deterministic job id (``"{project}--{trace}"``) BullMQ uses
            to dedup repeated adds for the same trace.
        data (dict): Job payload handed to the worker — ``traceId``,
            ``detectorIds`` and ``projectId``.

    Returns:
        None.
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
                    "delay": EVALUATOR_DELAY,
                    # The worker throws on a transient time-since-last-span/eval
                    # failure and relies on these retries. Back them off
                    # exponentially (5s, 10s, 20s, 40s) so a brief backend or
                    # ClickHouse blip doesn't burn every attempt in
                    # milliseconds and silently drop the trace.
                    "attempts": 5,
                    "backoff": {"type": "exponential", "delay": 5000},
                    "removeOnComplete": 100,
                    "removeOnFail": 50,
                },
            )
        finally:
            await queue.close()

    asyncio.run(_add())


_ORDERING_COMPARATORS = {
    ">": operator.gt,
    ">=": operator.ge,
    "<": operator.lt,
    "<=": operator.le,
}


def _scalar_equals(actual, value) -> bool:
    """Equality with numeric coercion, so a Decimal cost matches a JSON number the
    way ClickHouse's ``sum(cost) = X`` would."""
    numeric_types = (int, float, Decimal)
    if (
        isinstance(actual, numeric_types)
        and isinstance(value, numeric_types)
        and not isinstance(actual, bool)
        and not isinstance(value, bool)
    ):
        try:
            return float(actual) == float(value)
        except (TypeError, ValueError, OverflowError):
            return False
    return actual == value


def _eval_membership(values, op, value) -> bool:
    """Span-membership semantics for a multi-valued field (environment, model_name,
    metadata key values): ``=`` means some span carries the value, ``!=`` means none
    does, ``contains`` is a case-insensitive substring over the carried values —
    mirroring the trace-list filter's SPAN_MEMBERSHIP / keyed-map lowering."""
    if op == "=":
        return value in values
    if op == "!=":
        return value not in values
    if op == "contains":
        needle = str(value).lower()
        return any(isinstance(v, str) and needle in v.lower() for v in values)
    return False


def _eval_condition(trace_summary: dict, condition: dict) -> bool:
    """Evaluate a single trigger condition against a trace summary dict.

    A malformed condition evaluates False rather than raising, so one bad
    condition disables its own detector for the trace instead of dropping every
    detector's evaluation. Malformed covers the element itself (a legacy row can
    hold a bare string or null where a dict belongs) as well as its field, key
    and value.
    """
    if not isinstance(condition, dict):
        return False

    field = condition.get("field")
    if not isinstance(field, str):
        return False

    op = condition.get("op")
    value = condition.get("value")

    actual = trace_summary.get(field)
    if isinstance(actual, dict):
        key = condition.get("key")
        actual = actual.get(key, []) if isinstance(key, str) else []
    if isinstance(actual, list | tuple | set):
        return _eval_membership(actual, op, value)

    # For != conditions, a missing/null field counts as "not equal"
    if actual is None:
        return op == "!="

    if op == "=":
        return _scalar_equals(actual, value)
    if op == "!=":
        return not _scalar_equals(actual, value)
    if op == "contains":
        return isinstance(actual, str) and str(value).lower() in actual.lower()
    comparator = _ORDERING_COMPARATORS.get(op)
    if comparator is None:
        return False
    try:
        return comparator(float(actual), float(value))
    except (TypeError, ValueError, OverflowError):
        return False


def _passes_trigger(trace_summary: dict, conditions: list[dict]) -> bool:
    """All conditions must pass (AND logic). Empty conditions list = always passes."""
    return all(_eval_condition(trace_summary, c) for c in conditions)


def _merge_metadata_values(trace_map: dict | None, span_maps: list) -> dict[str, list[str]]:
    """Fold the trace-scope map and every span-scope map into {key: [values...]},
    so a metadata condition matches a key attached at either scope — the same OR
    the trace-list filter's keyed-map lowering answers."""
    merged: dict[str, list[str]] = {}
    for source in (trace_map or {}, *(span_maps or [])):
        if not isinstance(source, dict):
            continue
        for key, val in source.items():
            bucket = merged.setdefault(key, [])
            if val not in bucket:
                bucket.append(val)
    return merged


def _has_metadata_condition(detectors: list[dict]) -> bool:
    return any(
        isinstance(condition, dict) and condition.get("field") == "metadata"
        for detector in detectors
        for condition in detector.get("conditions") or []
    )


def _get_trace_summaries(
    project_id: str,
    trace_ids: list[str],
    *,
    include_trace_metadata: bool = True,
) -> dict[str, dict]:
    """Query ClickHouse for the per-trace fields trigger conditions evaluate against.

    The grain deliberately mirrors the trace-list filter registry
    (rest.services.filters.columns), so a detector filter answers the same
    question the list filter the user built it in answers. Both reads dedup
    before aggregating because ReplacingMergeTree may still hold an unmerged
    replay of a row at read time. Returns {trace_id: summary_dict}.
    """
    from db.clickhouse.client import get_clickhouse_client
    from rest.sql_utils import to_utc_naive

    if not trace_ids:
        return {}

    ch = get_clickhouse_client()
    parameters = {"project_id": project_id, "trace_ids": trace_ids}

    # The rows below are read positionally, so the gated-off shape substitutes a
    # constant for the metadata aggregate instead of dropping the column.
    span_metadata_expr = "groupUniqArray(metadata_map)" if include_trace_metadata else "[]"
    span_metadata_source = ", metadata_map" if include_trace_metadata else ""

    result = ch.query(
        f"""
        SELECT
            trace_id,
            groupUniqArray(environment) AS environments,
            groupUniqArray(model_name) AS model_names,
            sum(cost) AS cost,
            sum(total_tokens) AS total_tokens,
            if(
                max(span_end_time) IS NOT NULL,
                dateDiff('millisecond', min(span_start_time), max(span_end_time)),
                NULL
            ) AS duration_ms,
            countIf(status = 'ERROR') AS errors,
            {span_metadata_expr} AS span_metadata_maps,
            min(span_start_time) AS first_span_start
        FROM (
            SELECT trace_id, span_id, environment, model_name, cost, total_tokens,
                   span_start_time, span_end_time, status{span_metadata_source}
            FROM spans
            WHERE project_id = {{project_id:String}}
              AND trace_id IN {{trace_ids:Array(String)}}
            ORDER BY ch_update_time DESC
            LIMIT 1 BY project_id, trace_id, span_id
        )
        GROUP BY trace_id
        """,
        parameters=parameters,
    )

    trace_maps: dict[str, dict] = {}
    if include_trace_metadata and result.result_rows:
        # `traces` is ordered by (project_id, toDate(trace_start_time), trace_id), so
        # trace_id alone seeks nothing and an unbounded read scans every partition the
        # project has ever written. The bound comes from the data, not the clock: a
        # traces row copies its trace_start_time from one of the trace's spans, so the
        # earliest span start prunes without ever excluding a row this batch needs —
        # where a wall-clock lookback excludes every row a backfill or replay carries.
        first_span_start = to_utc_naive(min(row[8] for row in result.result_rows))
        trace_metadata = ch.query(
            """
            SELECT trace_id, metadata_map
            FROM traces
            WHERE project_id = {project_id:String}
              AND trace_start_time >= {first_span_start:DateTime64(3)}
              AND trace_id IN {trace_ids:Array(String)}
            ORDER BY ch_update_time DESC
            LIMIT 1 BY project_id, trace_id
            """,
            parameters={**parameters, "first_span_start": first_span_start},
        )
        trace_maps = {row[0]: row[1] for row in trace_metadata.result_rows}

    summaries: dict[str, dict] = {}
    for row in result.result_rows:
        trace_id = row[0]
        summaries[trace_id] = {
            "environment": row[1],
            "model_name": row[2],
            "cost": row[3],
            "total_tokens": row[4],
            "duration_ms": row[5],
            "errors": row[6],
            "metadata": _merge_metadata_values(trace_maps.get(trace_id), row[7]),
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


def _claim_and_enqueue(
    redis_client,
    project_id: str,
    trace_id: str,
    detectors: list[dict],
    summary: dict,
) -> None:
    """Root-bearing batch: claim the trace and enqueue at most one detection job.

    Takes the NX claim for ``(project_id, trace_id)``; if it wins, evaluates the
    trigger conditions plus deterministic sampling and enqueues a single delayed
    BullMQ job for the detectors that fire. A lost claim (ingest-task retry
    replay, duplicate root delivery, or a concurrent batch) is a no-op, keeping
    enqueue exactly-once.

    Args:
        redis_client (redis.Redis): Redis client for the NX claim and
            token-checked release.
        project_id (str): Project that owns the trace.
        trace_id (str): Trace whose root span arrived in this batch.
        detectors (list[dict]): Active detectors, each a dict with ``id``,
            ``sample_rate`` and ``conditions``.
        summary (dict): Trace summary fields used for trigger evaluation (e.g.
            ``environment``).

    Returns:
        None: On an enqueue failure the lock value this attempt wrote is
            released (so a later batch can re-claim) and the error is re-raised
            to the caller, which logs it per-trace without breaking ingestion.
    """
    # The lock's JSON payload (state/token/detector_ids) is diagnostic only —
    # nothing reads it back now that re-eval is gone; the key is purely an NX
    # dedup marker preventing a second enqueue for the same trace.
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


def enqueue_detector_runs(project_id: str, traces_with_root: set[str]) -> None:
    """Claim and (conditions + sampling permitting) enqueue detection for traces
    whose root span arrived in this ingest batch.

    Called after trace ingestion. Only the root-bearing traces are passed in;
    batches without a trace's root span enqueue nothing for it (the worker waits
    out the quiescence window before evaluating, so late spans need no enqueue).

    This function is intentionally non-raising — detector failures must not
    break trace ingestion.

    Args:
        project_id (str): Project that owns the traces.
        traces_with_root (set[str]): Trace IDs whose root span arrived in this
            batch; each is claimed once and enqueued if it triggers.
    """
    if not traces_with_root:
        return

    try:
        root_traces = list(traces_with_root)
        redis_client = _get_redis()
        detectors = _get_active_detectors(project_id)
        summaries = (
            _get_trace_summaries(
                project_id,
                root_traces,
                include_trace_metadata=_has_metadata_condition(detectors),
            )
            if detectors
            else {}
        )
        for trace_id in root_traces:
            # Per-trace try/except so an unexpected per-trace failure (Redis,
            # BullMQ) only drops the offending trace — remaining traces in the
            # batch still get enqueued. Malformed conditions no longer raise:
            # _eval_condition evaluates them False.
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

    except Exception as e:
        # Non-blocking: log and return, never raise
        logger.error(
            f"Failed to enqueue detector runs for project {project_id}: {e}",
            exc_info=True,
        )
