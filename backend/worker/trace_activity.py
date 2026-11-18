"""Tell the web app that a project received traces.

After the ingest task has written at least one span of a batch, it calls
:func:`schedule_trace_activity_report`. The web app's ``POST /api/internal/trace-activity``
records the project's first trace and the owner's active days, and tells a project
that already had traces from one receiving its first; this side only decides when to
send, and keeps trying until the report gets through.

At most one report per project per UTC day: a Redis key for the (project, day) is
claimed before the report is queued, held while the report is retried, and kept for
the rest of the day once the web app accepts it. The report is its own Celery task,
so ingestion never waits on it or fails because of it, and a failed report is
retried on its own schedule, without waiting for the project's next batch.
"""

import logging
import uuid
from datetime import UTC, datetime

import httpx
import redis as redis_lib

from shared.config import settings
from worker.celery_app import app

logger = logging.getLogger(__name__)

TRACE_ACTIVITY_PATH = "/api/internal/trace-activity"

# How long one attempt may take before it counts as failed. The web app may ask the
# trace store about the project before answering, so this is not a ping timeout.
REQUEST_TIMEOUT_SECONDS = 5.0

# How long a claim lasts before its report task starts or between retries. A task
# that is lost (its worker gone) frees the project for the next batch once it lapses.
CLAIM_TTL_SECONDS = 600

# Retries back off from a minute, doubling to half an hour: about eight hours in all.
RETRY_BASE_SECONDS = 60
RETRY_MAX_SECONDS = 30 * 60
MAX_RETRIES = 20

# A report the web app refuses (another 4xx) is not retried; its claim lapses after
# this, so a later batch may try again once the cause is fixed.
REFUSED_TTL_SECONDS = 60

# The key names its UTC day, so the reported marker only has to outlast that day.
REPORTED_TTL_SECONDS = 26 * 60 * 60

REPORTED = "reported"

# Token-checked expiry: extend the claim only while it still holds this report's token.
_EXPIRE_IF_VALUE_LUA = """
if redis.call('GET', KEYS[1]) == ARGV[1] then
    return redis.call('EXPIRE', KEYS[1], ARGV[2])
end
return 0
"""


def _claim_key(project_id: str, now: datetime) -> str:
    """Build the Redis key for one project's report on one UTC day.

    Args:
        project_id (str): Project whose spans were written.
        now (datetime): The current time, timezone-aware.

    Returns:
        str: The namespaced key for the (project, UTC day) report.
    """
    return f"trace-activity:{project_id}:{now.astimezone(UTC).date().isoformat()}"


def _redis():
    """A fresh connection, as for the live-span publish: Celery forks its workers.

    Returns:
        redis.Redis: A client that decodes responses to str.
    """
    return redis_lib.from_url(settings.redis.url, decode_responses=True)


def schedule_trace_activity_report(project_id: str, now: datetime | None = None) -> None:
    """Queue today's report for ``project_id`` unless it is queued or sent. Never raises.

    Skipped when this deployment has not given the worker the internal secret, so
    an install without it ingests exactly as before.

    Args:
        project_id (str): Project the ingest task just wrote spans for.
        now (datetime | None): The current time; defaults to now, in UTC.

    Returns:
        None.
    """
    if not settings.internal_api_secret:
        return
    key = _claim_key(project_id, now or datetime.now(UTC))
    token = uuid.uuid4().hex
    try:
        redis_client = _redis()
    except Exception as e:
        logger.warning(f"Trace activity report not queued, Redis unavailable: {e}")
        return
    try:
        if not redis_client.set(key, token, nx=True, ex=CLAIM_TTL_SECONDS):
            return  # queued or sent already today
        try:
            report_trace_activity.apply_async(args=[project_id, key, token])
        except Exception:
            _release(redis_client, key, token)
            raise
    except Exception as e:
        logger.warning(f"Trace activity report for project {project_id} not queued: {e}")
    finally:
        redis_client.close()


@app.task(bind=True, name="worker.trace_activity.report_trace_activity", max_retries=MAX_RETRIES)
def report_trace_activity(self, project_id: str, key: str, token: str) -> None:
    """Send the report, retrying with backoff until the web app accepts it.

    Args:
        project_id (str): Project to report.
        key (str): The day's claim key from :func:`_claim_key`.
        token (str): The value the claim was taken with.

    Returns:
        None.
    """
    secret = settings.internal_api_secret
    if not secret:
        return
    redis_client = _redis()
    try:
        try:
            response = httpx.post(
                f"{settings.traceroot_ui_url}{TRACE_ACTIVITY_PATH}",
                json={"projectId": project_id},
                headers={"X-Internal-Secret": secret},
                timeout=REQUEST_TIMEOUT_SECONDS,
            )
        except httpx.HTTPError as e:
            _retry_or_release(self, redis_client, key, token, f"not sent: {e}")
            return
        if response.is_success:
            redis_client.set(key, REPORTED, ex=REPORTED_TTL_SECONDS)
            return
        if response.status_code == 429 or response.status_code >= 500:
            _retry_or_release(self, redis_client, key, token, f"answered {response.status_code}")
            return
        redis_client.eval(_EXPIRE_IF_VALUE_LUA, 1, key, token, REFUSED_TTL_SECONDS)
        logger.warning(
            f"Trace activity report for project {project_id} refused with {response.status_code}"
        )
    finally:
        redis_client.close()


def _retry_or_release(task, redis_client, key: str, token: str, reason: str) -> None:
    """Retry a failed report later, holding the claim; or give the claim up when out of retries.

    Args:
        task (celery.Task): The bound report task.
        redis_client (redis.Redis): Connection holding the claim.
        key (str): The claim key.
        token (str): The value the claim was taken with.
        reason (str): What went wrong, for the log.

    Returns:
        None. Raises ``celery.exceptions.Retry`` when a retry is scheduled.
    """
    retries = task.request.retries
    if retries >= task.max_retries:
        _release(redis_client, key, token)
        logger.error(f"Trace activity report gave up after {retries} retries ({reason}): {key}")
        return
    countdown = min(RETRY_BASE_SECONDS * 2**retries, RETRY_MAX_SECONDS)
    redis_client.eval(_EXPIRE_IF_VALUE_LUA, 1, key, token, countdown + CLAIM_TTL_SECONDS)
    logger.warning(f"Trace activity report {reason}; retrying in {countdown}s: {key}")
    raise task.retry(countdown=countdown)


def _release(redis_client, key: str, token: str) -> None:
    """Give up the claim, so the project's next batch queues a new report.

    Args:
        redis_client (redis.Redis): Connection holding the claim.
        key (str): The claim key.
        token (str): The value the claim was taken with.

    Returns:
        None.
    """
    from worker.detector_tasks import _release_lock_if_value

    _release_lock_if_value(redis_client, key, token)
