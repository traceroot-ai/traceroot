"""The Celery tasks: the tick fans out to the due projects, the fit task returns its outcome."""

from worker.task_groups import job, tasks


def test_the_tick_enqueues_one_fit_per_due_project(monkeypatch):
    monkeypatch.setattr(job, "due_fits", lambda: [("p1", "daily"), ("p2", "refresh")])
    queued = []
    monkeypatch.setattr(tasks.fit_project_task, "delay", lambda *a: queued.append(a))
    assert tasks.tick() == 2
    assert queued == [("p1", "daily"), ("p2", "refresh")]


def test_the_tick_with_nothing_due_enqueues_nothing(monkeypatch):
    monkeypatch.setattr(job, "due_fits", lambda: [])
    monkeypatch.setattr(tasks.fit_project_task, "delay", lambda *a: pytest_fail())
    assert tasks.tick() == 0


def test_the_fit_task_returns_the_outcome_as_a_plain_dict(monkeypatch):
    monkeypatch.setattr(job, "fit_project", lambda p, t: job.FitOutcome("skipped", "off"))
    result = tasks.fit_project_task("p", "daily")
    assert result["status"] == "skipped" and result["reason"] == "off"


def pytest_fail():
    raise AssertionError("nothing should be queued")


def test_the_tick_is_on_the_beat_schedule():
    from worker.celery_app import app

    entry = app.conf.beat_schedule["task-group-tick"]
    assert entry["task"] == "worker.task_groups.tasks.tick"
    assert entry["schedule"] == tasks.TICK_SECONDS
