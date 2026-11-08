"""One fit for one project, and the scheduling around it."""

from __future__ import annotations

import logging
import os
import resource
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass

import numpy as np

from worker.task_groups import store
from worker.task_groups.fit import FitParams, exemplar_indices, fit_groups
from worker.task_groups.identity import match_groups, new_group_id
from worker.task_groups.naming import name_group

logger = logging.getLogger(__name__)

EXEMPLARS_FOR_NAME = 10
EXEMPLARS_STORED = 8
NAMING_THREADS = 4


@dataclass
class FitOutcome:
    status: str  # succeeded | skipped | duplicate | failed
    reason: str = ""
    fit_id: str | None = None
    digests: int = 0
    groups: int = 0
    unassigned: int = 0
    kept_ids: int = 0
    new_ids: int = 0
    named: int = 0
    naming_cost_usd: float = 0.0
    duration_ms: int = 0
    peak_rss_mb: int = 0


def _name_new_groups(
    pending: list[tuple[int, list[str]]], taken: list[str], api_key: str
) -> tuple[dict[int, tuple[str, str]], float]:
    """Name each new cluster. A name already in use gets one more try with the used names listed."""
    names: dict[int, tuple[str, str]] = {}
    cost = 0.0

    def work(item: tuple[int, list[str]]):
        label, summaries = item
        return label, name_group(summaries, taken, api_key=api_key)

    with ThreadPoolExecutor(max_workers=NAMING_THREADS) as pool:
        for label, result in pool.map(work, pending):
            names[label] = (result.name, result.description)
            cost += result.cost_usd
    used = {n.lower() for n in taken}
    for label, summaries in pending:
        name, _ = names[label]
        if name.lower() in used:
            retry = name_group(summaries, sorted(used), api_key=api_key)
            names[label] = (retry.name, retry.description)
            cost += retry.cost_usd
        used.add(names[label][0].lower())
    return names, cost


def fit_project(project_id: str, trigger: str, params: FitParams = FitParams()) -> FitOutcome:
    """Fit one project's groups now, if it is enabled, has enough summaries, and this
    trigger still holds its claim (so a second firing of the same tick does nothing).
    """
    started = time.monotonic()
    now = store.utc_now()
    api_key = os.environ.get("OPENAI_API_KEY", "").strip()
    if not store.is_enabled(project_id):
        return FitOutcome("skipped", "off")
    if not api_key:
        return FitOutcome("skipped", "no_key")
    # Below the gate nothing is claimed, so the first map builds itself the day it crosses.
    from worker.task_groups.fit import MIN_DIGESTS

    if store.count_window(project_id, now) < MIN_DIGESTS:
        return FitOutcome("skipped", "too_few_summaries")

    run_id = (
        store.claim_daily(project_id, now.date())
        if trigger == "daily"
        else store.claim_refresh(project_id, now.date())
    )
    if run_id is None:
        return FitOutcome("duplicate", f"{trigger} already claimed")

    try:
        outcome = _fit_claimed(project_id, now, api_key, params)
    except Exception as e:  # recorded on the run; the next tick may retry a daily one
        logger.exception("task-group fit failed for %s", project_id)
        store.finish_run(run_id, status="failed", error=f"{type(e).__name__}: {e}"[:500])
        return FitOutcome("failed", f"{type(e).__name__}")
    outcome.duration_ms = int((time.monotonic() - started) * 1000)
    outcome.peak_rss_mb = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss // 1024
    store.finish_run(
        run_id,
        status=outcome.status,
        fit_id=outcome.fit_id,
        digest_count=outcome.digests,
        group_count=outcome.groups,
        noise_count=outcome.unassigned,
        duration_ms=outcome.duration_ms,
    )
    return outcome


def _fit_claimed(project_id: str, now, api_key: str, params: FitParams) -> FitOutcome:
    window = store.load_window(project_id, now)
    result = fit_groups(window.vectors, params)
    if result is None:
        return FitOutcome("skipped", "too_few_summaries", digests=len(window.trace_ids))
    k = result.centers.shape[0]
    previous = store.load_previous(project_id)

    new_members = {
        c: {window.trace_ids[i] for i in np.flatnonzero(result.labels == c)} for c in range(k)
    }
    matched = match_groups(previous.members, new_members, previous.known)
    group_ids = [matched[c] or new_group_id() for c in range(k)]
    kept = sum(1 for c in range(k) if matched[c])

    pending = [
        (
            c,
            [
                window.summaries[i]
                for i in exemplar_indices(window.vectors, result, c, EXEMPLARS_FOR_NAME)
            ],
        )
        for c in range(k)
        if not matched[c]
    ]
    taken = [
        previous.groups[matched[c]]["name"]
        for c in range(k)
        if matched[c] and matched[c] in previous.groups
    ]
    names, naming_cost = _name_new_groups(pending, taken, api_key) if pending else ({}, 0.0)
    if naming_cost:
        store.add_spend(project_id, now.date(), naming_cost)

    groups = []
    for c in range(k):
        old = previous.groups.get(matched[c] or "")
        name, description = (old["name"], old["description"]) if old else names[c]
        groups.append(
            {
                "group_id": group_ids[c],
                "name": name,
                "description": description,
                "center": result.centers[c],
                "reach": result.reaches[c],
                "size": int(result.sizes[c]),
                "exemplar_trace_ids": [
                    window.trace_ids[i]
                    for i in exemplar_indices(window.vectors, result, c, EXEMPLARS_STORED)
                ],
            }
        )
    fit_id = uuid.uuid4().hex
    store.write_fit(
        project_id,
        fit_id=fit_id,
        window=window,
        group_ids=group_ids,
        labels=result.labels,
        distances=result.distances,
        groups=groups,
        now=now,
    )
    return FitOutcome(
        "succeeded",
        fit_id=fit_id,
        digests=len(window.trace_ids),
        groups=k,
        unassigned=int((result.labels < 0).sum()),
        kept_ids=kept,
        new_ids=k - kept,
        named=len(pending),
        naming_cost_usd=naming_cost,
    )


def due_fits() -> list[tuple[str, str]]:
    """(project, trigger) pairs that should fit now. A refresh request wins over the daily run."""
    today = store.utc_now().date()
    due = []
    for project_id in store.enabled_projects():
        if store.refresh_pending(project_id):
            due.append((project_id, "refresh"))
        elif store.daily_due(project_id, today):
            due.append((project_id, "daily"))
    return due
