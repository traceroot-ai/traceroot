"""Celery tasks: a tick that finds projects due for a fit, and the fit itself."""

from __future__ import annotations

import logging

from worker.celery_app import app
from worker.task_groups import job

logger = logging.getLogger(__name__)

TICK_SECONDS = 600.0


@app.task(name="worker.task_groups.tasks.fit_project", acks_late=True)
def fit_project_task(project_id: str, trigger: str) -> dict:
    outcome = job.fit_project(project_id, trigger)
    logger.info("task-group fit %s (%s): %s", project_id, trigger, outcome)
    return outcome.__dict__


@app.task(name="worker.task_groups.tasks.tick")
def tick() -> int:
    """Enqueue a fit for every project that is due. Firing twice is harmless: the fit
    task claims its run in Postgres, so only one of two queued fits does the work."""
    due = job.due_fits()
    for project_id, trigger in due:
        fit_project_task.delay(project_id, trigger)
    return len(due)
