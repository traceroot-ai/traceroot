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
            continue
        if isinstance(conditions, str):
            conditions = json.loads(conditions)
        if not isinstance(conditions, list):
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

    # Prevent duplicate processing on Celery retries
    if idempotency_key:
        processed_key = f"budget:processed:{idempotency_key}"
        # Set processed key in Redis with 24h expiry to automatically reclaim memory
        was_set = redis_client.set(processed_key, "1", ex=86400, nx=True)
        if not was_set:
            logger.info(
                f"Budget check skipped for project {project_id} (idempotency key {idempotency_key} already processed)"
            )
            return

    budget_detectors = _get_budget_detectors_cached(redis_client, project_id)
    if not budget_detectors:
        return

    for detector in budget_detectors:
        try:
            _check_single_detector(redis_client, project_id, detector, batch_cost)
        except Exception:
            logger.error(
                f"Budget check failed for detector {detector['id']}",
                exc_info=True,
            )


def _check_single_detector(
    redis_client,
    project_id: str,
    detector: dict,
    batch_cost: float,
) -> None:
    """Check a single budget detector against the running Redis counter."""
    threshold_usd = detector["threshold_usd"]
    window = detector["window"]
    window_secs = WINDOW_SECONDS[window]
    detector_id = detector["id"]

    # 1. INCRBYFLOAT — O(1), atomic
    #
    # Counter key is scoped to the current window EPOCH (same as the cooldown
    # and finding-ID keys) so that spend from adjacent windows never pollutes
    # each other. Without the epoch, an un-expired counter from window N would
    # be incremented into window N+1, producing false-positive alerts.
    window_epoch = int(time.time()) // window_secs * window_secs
    counter_key = f"budget:project:{project_id}:{detector_id}:{window}-{window_epoch}"
    new_total = float(redis_client.incrbyfloat(counter_key, batch_cost))

    # Set TTL on first write — key expires naturally when the window ends.
    ttl = redis_client.ttl(counter_key)
    if ttl == -1:  # no expiry set yet (key is new or lost TTL)
        redis_client.expire(counter_key, window_secs)

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
            # First breach in this window — enqueue finding
            _enqueue_budget_finding(redis_client, project_id, detector, new_total)
        else:
            logger.debug(
                f"Budget alert suppressed (cooldown active): "
                f"project={project_id} detector={detector_id} "
                f"spend=${new_total:.2f}"
            )
