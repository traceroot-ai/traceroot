"""Budget alert checks — inline in the Python ingest path.

After every span batch is inserted into ClickHouse, this module:
1. Sums the batch cost (already computed, in memory)
2. Increments a per-project Redis counter (INCRBYFLOAT, O(1))
3. If the counter crosses a configured threshold and no cooldown key
   exists, enqueues a pre-resolved budget finding to the TS detector
   worker via BullMQ.

Performance: ~1-3ms per ingest batch (Redis round-trips only).
ClickHouse queries: zero. LLM cost: zero.

Reconciliation safety net: the hourly billing cron in usageMetering.ts
re-checks authoritative ClickHouse data and catches Redis data loss.
"""

import hashlib
import json
import logging
import time
import uuid

logger = logging.getLogger(__name__)

# BullMQ queue name — must match TypeScript DETECTOR_RUN_QUEUE constant
DETECTOR_RUN_QUEUE = "detector-run"

# Window durations in seconds
WINDOW_SECONDS = {
    "1h": 3600,
    "24h": 86400,
    "7d": 604800,
    "30d": 2592000,
}

# Cache TTL for budget detector config (seconds)
_DETECTOR_CACHE_TTL = 60


def _get_redis():
    """Get Redis client using same connection as Celery broker."""
    import redis

    from worker.celery_app import app as celery_app

    return redis.from_url(celery_app.conf.broker_url)


def _get_budget_detectors_cached(redis_client, project_id: str) -> list[dict]:
    """Load budget detectors for a project, cached in Redis for 60s.

    Returns list of dicts: [{id, name, threshold_usd, window}, ...]
    """
    cache_key = f"budget:detectors:{project_id}"

    # Try cache first
    cached = redis_client.get(cache_key)
    if cached is not None:
        try:
            return json.loads(cached)
        except (json.JSONDecodeError, TypeError):
            pass

    # Cache miss — query PostgreSQL
    detectors = _fetch_budget_detectors(project_id)

    # Cache the result (even empty list, to avoid repeated DB queries)
    redis_client.set(cache_key, json.dumps(detectors), ex=_DETECTOR_CACHE_TTL)

    return detectors


def _fetch_budget_detectors(project_id: str) -> list[dict]:
    """Fetch budget detectors and their config from PostgreSQL.

    Budget config is stored in detector_triggers.conditions as:
    [
        {"field": "budget_threshold_usd", "op": "=", "value": 100.0},
        {"field": "budget_window", "op": "=", "value": "24h"},
    ]
    """
    import psycopg2

    from shared.config import settings

    conn = psycopg2.connect(settings.database_url)
    try:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT d.id, d.name, dt.conditions
                FROM detectors d
                LEFT JOIN detector_triggers dt ON dt.detector_id = d.id
                WHERE d.project_id = %s
                  AND d.enabled = TRUE
                  AND d.template = 'budget'
                """,
                (project_id,),
            )
            rows = cur.fetchall()
    finally:
        conn.close()

    detectors = []
    for detector_id, detector_name, conditions in rows:
        # Parse conditions JSONB
        if conditions is None:
            logger.error(
                f"Budget detector {detector_id} ({detector_name!r}) has no trigger "
                f"conditions — it will be silently excluded from spend enforcement. "
                f"Ensure a detector_triggers row exists with a valid conditions array."
            )
            continue
        if isinstance(conditions, str):
            try:
                conditions = json.loads(conditions)
            except (json.JSONDecodeError, ValueError) as exc:
                logger.error(
                    f"Budget detector {detector_id} ({detector_name!r}) has unparseable "
                    f"conditions JSON: {exc}. Raw value: {conditions[:200]!r}. "
                    f"Detector excluded from spend enforcement."
                )
                continue
        if not isinstance(conditions, list):
            logger.error(
                f"Budget detector {detector_id} ({detector_name!r}) has conditions of "
                f"type {type(conditions).__name__!r} (expected list). "
                f"Actual value: {str(conditions)[:200]!r}. "
                f"Detector excluded from spend enforcement — fix the trigger config."
            )
            continue

        # Extract budget config from conditions
        threshold_usd = None
        window = None
        for cond in conditions:
            field = cond.get("field")
            value = cond.get("value")
            if field == "budget_threshold_usd":
                threshold_usd = float(value)
            elif field == "budget_window":
                window = str(value)

        if threshold_usd is None or window not in WINDOW_SECONDS:
            logger.warning(
                f"Budget detector {detector_id} has invalid config: "
                f"threshold={threshold_usd}, window={window}"
            )
            continue

        detectors.append(
            {
                "id": detector_id,
                "name": detector_name,
                "threshold_usd": threshold_usd,
                "window": window,
            }
        )

    return detectors


def _deterministic_finding_id(project_id: str, detector_id: str, window_key: str) -> str:
    """Generate a stable finding ID for deduplication.

    Uses the project, detector, and window key so the same budget breach
    in the same window always produces the same finding ID. ClickHouse's
    ReplacingMergeTree deduplicates on this.
    """
    raw = f"budget:{project_id}:{detector_id}:{window_key}"
    h = hashlib.sha256(raw.encode()).hexdigest()[:32]
    # Format as UUID-like string
    return f"{h[:8]}-{h[8:12]}-{h[12:16]}-{h[16:20]}-{h[20:32]}"


def _enqueue_budget_finding(
    redis_client,
    project_id: str,
    detector: dict,
    current_spend: float,
) -> None:
    """Enqueue a pre-resolved budget finding to BullMQ.

    The TS detector-run-processor recognizes the `budgetAlert` field
    and skips LLM eval — it writes the finding directly and triggers
    notification fan-out.
    """
    # Window key for dedup: e.g. "24h-1716883200" (window + epoch of window start)
    window_secs = WINDOW_SECONDS[detector["window"]]
    window_epoch = int(time.time()) // window_secs * window_secs
    window_key = f"{detector['window']}-{window_epoch}"

    finding_id = _deterministic_finding_id(project_id, detector["id"], window_key)

    summary = (
        f"Budget alert: ${current_spend:.2f} spent in the last {detector['window']} "
        f"(threshold: ${detector['threshold_usd']:.2f})"
    )

    job_data = {
        "traceId": "",  # budget alerts are project-level, not trace-specific
        "detectorIds": [],
        "projectId": project_id,
        "budgetAlert": {
            "findingId": finding_id,
            "detectorId": detector["id"],
            "detectorName": detector["name"],
            "summary": summary,
            "data": {
                "threshold_usd": detector["threshold_usd"],
                "current_spend_usd": round(current_spend, 4),
                "window": detector["window"],
            },
        },
    }

    job_id = f"budget-{project_id}-{detector['id']}-{window_key}"
    timestamp_ms = int(time.time() * 1000)
    job_hash_key = f"bull:{DETECTOR_RUN_QUEUE}:{job_id}"

    redis_client.hset(
        job_hash_key,
        mapping={
            "name": "budget-alert",
            "data": json.dumps(job_data),
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
    redis_client.rpush(f"bull:{DETECTOR_RUN_QUEUE}:wait", job_id)

    logger.info(
        f"Budget alert enqueued: project={project_id} detector={detector['id']} "
        f"spend=${current_spend:.2f} threshold=${detector['threshold_usd']:.2f} "
        f"window={detector['window']}"
    )


def check_budget_thresholds(
    project_id: str,
    batch_cost: float,
    idempotency_key: str | None = None,
) -> None:
    """Inline budget check on every ingest batch.

    Called from ingest_tasks.py after span insert. O(1) Redis ops per
    budget detector, no ClickHouse queries.

    Args:
        project_id: The project whose spans were just ingested.
        batch_cost: Total cost from the current span batch (already computed).
        idempotency_key: Optional stable key to prevent overcounting on Celery retries.
    """
    if batch_cost <= 0:
        return

    try:
        redis_client = _get_redis()
    except Exception:
        logger.warning("Failed to get Redis client for budget check", exc_info=True)
        return

    # Prevent duplicate processing on Celery retries.
    # Strategy: per-detector sub-keys (budget:processed:{key}:{detector_id})
    # are written immediately after each detector succeeds. The batch-level key
    # (budget:processed:{key}) is written only once every detector is done.
    #
    # This means:
    # - A retry skips detectors that already succeeded (no duplicate alerts).
    # - A retry re-runs only the detectors that failed (no silent misses).
    processed_key = f"budget:processed:{idempotency_key}" if idempotency_key else None
    if processed_key and redis_client.get(processed_key):
        logger.info(
            f"Budget check skipped for project {project_id} "
            f"(idempotency key {idempotency_key} already processed)"
        )
        return

    budget_detectors = _get_budget_detectors_cached(redis_client, project_id)
    if not budget_detectors:
        # Nothing to do — mark processed so future retries skip the DB lookup too.
        if processed_key:
            redis_client.set(processed_key, "1", ex=86400, nx=True)
        return

    failed = False
    for detector in budget_detectors:
        detector_id = detector["id"]

        # Skip detectors that already succeeded on a previous attempt.
        detector_processed_key = (
            f"{processed_key}:{detector_id}" if processed_key else None
        )
        if detector_processed_key and redis_client.get(detector_processed_key):
            logger.debug(
                f"Detector {detector_id} already processed for batch "
                f"{idempotency_key}, skipping"
            )
            continue

        try:
            _check_single_detector(redis_client, project_id, detector, batch_cost, idempotency_key)
            # Mark this detector as done immediately so a retry won't repeat it.
            if detector_processed_key:
                redis_client.set(detector_processed_key, "1", ex=86400, nx=True)
        except Exception:
            failed = True
            logger.error(
                f"Budget check failed for detector {detector_id}",
                exc_info=True,
            )

    # Write the batch-level key only when every detector has been individually
    # marked. On the next retry the top-level GET will short-circuit immediately.
    if processed_key and not failed:
        redis_client.set(processed_key, "1", ex=86400, nx=True)


def _check_single_detector(
    redis_client,
    project_id: str,
    detector: dict,
    batch_cost: float,
    idempotency_key: str | None = None,
) -> None:
    """Check a single budget detector against the running Redis counter."""
    threshold_usd = detector["threshold_usd"]
    window = detector["window"]
    window_secs = WINDOW_SECONDS[window]
    detector_id = detector["id"]

    # 1. Rolling-window spend accumulation via a Redis Sorted Set.
    #
    # Key is scoped to project + detector + window only — no epoch bucket.
    # Each ingest batch writes a unique member that encodes the batch cost,
    # with the current Unix timestamp as its score. ZREMRANGEBYSCORE prunes
    # entries older than one full window on every write, so the set always
    # holds at most one window's worth of batches.
    #
    # This gives a true rolling lookback (now − window_secs → now) rather
    # than snapping to a fixed UTC boundary. The old INCRBYFLOAT approach
    # keyed on `floor(now / window_secs) * window_secs`, meaning "24h"
    # measured "since the start of the current UTC day" — undercounting early
    # in the day and potentially overcounting/missing alerts near midnight.
    now = time.time()
    counter_key = f"budget:project:{project_id}:{detector_id}:{window}"
    # Member encodes cost so we can sum without an extra round-trip.
    #
    # When an idempotency_key is available (Celery task ID or batch hash), use
    # it as the member suffix instead of a random UUID. ZADD on an existing
    # member only updates its score (timestamp) — it does NOT add a new entry —
    # so a Celery retry that reaches this line before `budget:processed:*` is
    # written will be a no-op on the sorted set rather than adding the same
    # batch cost a second time.
    #
    # Without idempotency_key (fire-and-forget call sites), fall back to a
    # random UUID so concurrent batches at the same millisecond don’t collapse.
    if idempotency_key:
        member = f"{batch_cost}:{idempotency_key}:{detector_id}"
    else:
        member = f"{batch_cost}:{uuid.uuid4().hex[:8]}"
    redis_client.zadd(counter_key, {member: now})
    # Prune entries that have rolled out of the window.
    redis_client.zremrangebyscore(counter_key, "-inf", now - window_secs)
    # Self-expiry after one idle window + small buffer for clock drift.
    redis_client.expire(counter_key, window_secs + 60)

    # Sum the cost of all entries still within the rolling window.
    entries = redis_client.zrangebyscore(counter_key, now - window_secs, "+inf")
    new_total = 0.0
    for entry in entries:
        if isinstance(entry, bytes):
            entry = entry.decode("utf-8")
        try:
            # Member format: "{cost}:{unique_suffix}" — first segment is cost.
            new_total += float(entry.split(":")[0])
        except (ValueError, TypeError):
            pass

    # 2. Threshold check + cooldown
    if new_total >= threshold_usd:
        # Window key for cooldown: e.g. "24h-1716883200" (same epoch used for deduplicating finding IDs)
        window_epoch = int(time.time()) // window_secs * window_secs
        window_key = f"{window}-{window_epoch}"

        # Cooldown key includes window_key so it is scoped entirely to the specific window epoch.
        # This prevents a cooldown in the previous window from suppressing the first alert in the next.
        cooldown_key = f"budget:alert:cooldown:{project_id}:{detector_id}:{window_key}"
        # SET NX = only set if key does not exist (atomic check-and-set)
        was_set = redis_client.set(cooldown_key, "1", ex=window_secs, nx=True)

        if was_set:
            # First breach in this window — enqueue finding.
            # If enqueueing fails we MUST release the cooldown key so the next
            # ingest batch can retry. Leaving a cooldown key without a durably
            # queued job would silently suppress the alert for the whole window.
            try:
                _enqueue_budget_finding(redis_client, project_id, detector, new_total)
            except Exception:
                redis_client.delete(cooldown_key)
                raise
        else:
            logger.debug(
                f"Budget alert suppressed (cooldown active): "
                f"project={project_id} detector={detector_id} "
                f"spend=${new_total:.2f}"
            )
