"""Tell the web app that a project received traces.

After the ingest task has written at least one span of a batch, it calls
:func:`schedule_trace_activity_report`. The web app's ``POST /api/internal/trace-activity``
records the project's first trace and the owner's active days, and tells a project
that already had traces from one receiving its first; this side only decides when to
send, and keeps trying until the report gets through.

At most one report per project per UTC day: a Redis key for the (project, day) is
claimed before the report is queued, held while the report is retried, and kept for
the rest of the day once the web app accepts it. The day is the one the API received
the batch on, carried in the report and through its retries, so a batch that waited
in the queue past midnight, or a report retried past it, counts for the day the
traces arrived. The report is its own Celery task, so ingestion never waits on it or
fails because of it, and a failed report is retried on its own schedule, without
waiting for the project's next batch.

Before its first report the worker tells the web app when it started reporting
(:func:`record_tracking_start`): the cutoff between projects that already had traces
and projects receiving their first. It does so as it starts, too, so the cutoff is in
place before any report arrives.
"""

import logging
import uuid
from datetime import UTC, date, datetime

import httpx
import redis as redis_lib

from shared.config import settings
from worker.celery_app import app

logger = logging.getLogger(__name__)

TRACE_ACTIVITY_PATH = "/api/internal/trace-activity"
TRACKING_START_PATH = "/api/internal/first-trace-tracking"

# When this worker started reporting: taken as the worker loads its tasks, before it
# processes any batch, so every span it writes was received after it. The pool's
# processes inherit it.
REPORTING_STARTED_AT = datetime.now(UTC)

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

# Whether this process has had the web app record a start (see record_tracking_start).
_tracking_start_recorded = False

# Token-checked expiry: extend the claim only while it still holds this report's token.
_EXPIRE_IF_VALUE_LUA = """
if redis.call('GET', KEYS[1]) == ARGV[1] then
    return redis.call('EXPIRE', KEYS[1], ARGV[2])
end
return 0
"""


def _utc_day(at: datetime) -> date:
    """The UTC calendar day of ``at``; a time without an offset is taken as UTC.

    Args:
        at (datetime): A point in time.

    Returns:
        date: Its day in UTC.
    """
    return (at if at.tzinfo else at.replace(tzinfo=UTC)).astimezone(UTC).date()


def _claim_key(project_id: str, day: date) -> str:
    """Build the Redis key for one project's report on one UTC day.

    Args:
        project_id (str): Project whose spans were written.
        day (date): The UTC day the batch was received.

    Returns:
        str: The namespaced key for the (project, UTC day) report.
    """
    return f"trace-activity:{project_id}:{day.isoformat()}"


def _redis():
    """A fresh connection, as for the live-span publish: Celery forks its workers.

    Returns:
        redis.Redis: A client that decodes responses to str.
    """
    return redis_lib.from_url(settings.redis.url, decode_responses=True)


def schedule_trace_activity_report(project_id: str, received_at: datetime | None = None) -> None:
    """Queue the report for the day the batch arrived, unless it is queued or sent. Never raises.

    Skipped when this deployment has not given the worker the internal secret, so
    an install without it ingests exactly as before.

    Args:
        project_id (str): Project the ingest task just wrote spans for.
        received_at (datetime | None): When the API received the batch; its UTC day
            is the day reported. A batch queued without one counts the day it is
            processed.

    Returns:
        None.
    """
    if not settings.internal_api_secret:
        return
    day = _utc_day(received_at or datetime.now(UTC))
    key = _claim_key(project_id, day)
    token = uuid.uuid4().hex
    try:
        redis_client = _redis()
    except Exception as e:
        logger.warning(f"Trace activity report not queued, Redis unavailable: {e}")
        return
    try:
        if not redis_client.set(key, token, nx=True, ex=CLAIM_TTL_SECONDS):
            return  # queued or sent already for that day
        try:
            report_trace_activity.apply_async(args=[project_id, key, token, day.isoformat()])
        except Exception:
            _release(redis_client, key, token)
            raise
    except Exception as e:
        logger.warning(f"Trace activity report for project {project_id} not queued: {e}")
    finally:
        redis_client.close()


@app.task(bind=True, name="worker.trace_activity.report_trace_activity", max_retries=MAX_RETRIES)
def report_trace_activity(
    self, project_id: str, key: str, token: str, day: str | None = None
) -> None:
    """Send the report, retrying with backoff until the web app accepts it.

    Args:
        project_id (str): Project to report.
        key (str): The day's claim key from :func:`_claim_key`.
        token (str): The value the claim was taken with.
        day (str | None): The UTC day the batch was received, ``YYYY-MM-DD``; every
            retry sends the same one. A task queued before reports carried the day
            leaves it to the web app, which counts the day the report arrives.

    Returns:
        None.
    """
    secret = settings.internal_api_secret
    if not secret:
        return
    redis_client = _redis()
    try:
        if not record_tracking_start():
            _retry_or_release(self, redis_client, key, token, "reporting start not recorded")
            return
        body = {"projectId": project_id} | ({"day": day} if day else {})
        try:
            response = _post_report(secret, body)
            if response.status_code == 409:
                # The web app has lost its cutoff and changed nothing: record the
                # start again, then send the report once more.
                _forget_tracking_start()
                if record_tracking_start():
                    response = _post_report(secret, body)
        except httpx.HTTPError as e:
            _retry_or_release(self, redis_client, key, token, f"not sent: {e}")
            return
        if response.is_success:
            redis_client.set(key, REPORTED, ex=REPORTED_TTL_SECONDS)
            return
        if response.status_code in (409, 429) or response.status_code >= 500:
            _retry_or_release(self, redis_client, key, token, f"answered {response.status_code}")
            return
        redis_client.eval(_EXPIRE_IF_VALUE_LUA, 1, key, token, REFUSED_TTL_SECONDS)
        logger.warning(
            f"Trace activity report for project {project_id} refused with {response.status_code}"
        )
    finally:
        redis_client.close()


def _post_report(secret: str, body: dict[str, str]) -> httpx.Response:
    """POST one report to the web app.

    Args:
        secret (str): The internal API secret.
        body (dict[str, str]): The report: ``projectId`` and, when known, ``day``.

    Returns:
        httpx.Response: The web app's answer. Raises ``httpx.HTTPError`` when none came.
    """
    return httpx.post(
        f"{settings.traceroot_ui_url}{TRACE_ACTIVITY_PATH}",
        json=body,
        headers={"X-Internal-Secret": secret},
        timeout=REQUEST_TIMEOUT_SECONDS,
    )


def _forget_tracking_start() -> None:
    """Make this process record its start again before its next report.

    Returns:
        None.
    """
    global _tracking_start_recorded
    _tracking_start_recorded = False


def record_tracking_start() -> bool:
    """Have the web app record when this worker started reporting. Never raises.

    The web app keeps the first start it is given as the cutoff, and refuses a report
    it cannot place against one, so this runs before this process's first report, and
    as the worker starts, so the cutoff is in place before any report arrives. Once
    the web app has recorded a start, later calls in this process send nothing.

    Returns:
        bool: True once the web app has a start recorded.
    """
    global _tracking_start_recorded
    if _tracking_start_recorded:
        return True
    secret = settings.internal_api_secret
    if not secret:
        return False
    try:
        response = httpx.post(
            f"{settings.traceroot_ui_url}{TRACKING_START_PATH}",
            json={"startedAt": REPORTING_STARTED_AT.isoformat()},
            headers={"X-Internal-Secret": secret},
            timeout=REQUEST_TIMEOUT_SECONDS,
        )
    except httpx.HTTPError as e:
        logger.warning(f"Reporting start not recorded, not sent: {e}")
        return False
    if not response.is_success:
        logger.warning(f"Reporting start not recorded, answered {response.status_code}")
        return False
    _tracking_start_recorded = True
    return True


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
