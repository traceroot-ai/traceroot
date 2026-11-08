"""The fit job's decisions, with storage and naming replaced by fakes."""

from datetime import UTC, datetime

import numpy as np
import pytest

from worker.task_groups import job
from worker.task_groups.fit import FitParams
from worker.task_groups.naming import GroupName
from worker.task_groups.store import PreviousFit, Window


def blob_window(per=60, k=3, dim=64):
    rng = np.random.default_rng(0)
    centers = rng.normal(size=(k, dim))
    x = np.concatenate([centers[i] + 0.3 * rng.normal(size=(per, dim)) for i in range(k)])
    ids = [f"t{i:04d}" for i in range(len(x))]
    now = datetime(2026, 11, 8, tzinfo=UTC)
    return Window(ids, [now] * len(ids), [f"summary {i}" for i in ids], x.astype(np.float32))


class FakeStore:
    def __init__(self, window, previous=None, enabled=True, count=None, claim="run1"):
        self.window, self.previous = window, previous or PreviousFit(None, {}, {}, set())
        self.enabled, self.claim = enabled, claim
        self.count = len(window.trace_ids) if count is None else count
        self.written, self.finished, self.spend = [], [], []

    def utc_now(self):
        return datetime(2026, 11, 8, 12, tzinfo=UTC)

    def is_enabled(self, p):
        return self.enabled

    def count_window(self, p, now):
        return self.count

    def claim_daily(self, p, day):
        return self.claim

    def claim_refresh(self, p, day):
        return self.claim

    def load_window(self, p, now):
        return self.window

    def load_previous(self, p):
        return self.previous

    def write_fit(self, p, **kw):
        self.written.append(kw)

    def finish_run(self, run_id, **kw):
        self.finished.append((run_id, kw))

    def add_spend(self, p, day, cost):
        self.spend.append(cost)


@pytest.fixture()
def wired(monkeypatch):
    def install(store):
        for name in (
            "utc_now",
            "is_enabled",
            "count_window",
            "claim_daily",
            "claim_refresh",
            "load_window",
            "load_previous",
            "write_fit",
            "finish_run",
            "add_spend",
        ):
            monkeypatch.setattr(job.store, name, getattr(store, name))
        calls = []

        def fake_name(summaries, taken, *, api_key, client=None):
            calls.append(list(taken))
            return GroupName(f"Group {len(calls)}", "About it.", 0.001)

        monkeypatch.setattr(job, "name_group", fake_name)
        monkeypatch.setenv("OPENAI_API_KEY", "k")
        return calls

    return install


def test_does_nothing_when_the_feature_is_off(wired):
    store = FakeStore(blob_window(), enabled=False)
    wired(store)
    assert job.fit_project("p", "daily").reason == "off"
    assert not store.written


def test_does_nothing_without_a_model_key(wired, monkeypatch):
    store = FakeStore(blob_window())
    wired(store)
    monkeypatch.delenv("OPENAI_API_KEY")
    assert job.fit_project("p", "daily").reason == "no_key"


def test_below_the_gate_it_neither_claims_nor_writes(wired):
    store = FakeStore(blob_window(), count=40, claim="would-claim")
    wired(store)
    out = job.fit_project("p", "daily")
    assert (out.status, out.reason) == ("skipped", "too_few_summaries")
    assert not store.written and not store.finished


def test_a_lost_claim_means_another_run_has_it(wired):
    store = FakeStore(blob_window(), claim=None)
    calls = wired(store)
    out = job.fit_project("p", "daily")
    assert out.status == "duplicate" and not store.written and not calls


def test_a_first_fit_names_every_group_and_writes_the_fit(wired):
    store = FakeStore(blob_window())
    calls = wired(store)
    out = job.fit_project("p", "daily")
    assert out.status == "succeeded" and out.groups == 3 and out.new_ids == 3
    assert len(calls) == 3 and len(store.written) == 1
    assert [g["name"] for g in store.written[0]["groups"]] == ["Group 1", "Group 2", "Group 3"]
    assert store.finished[0][1]["status"] == "succeeded" and store.spend == [pytest.approx(0.003)]


def test_a_second_fit_keeps_ids_and_names_and_makes_no_naming_call(wired):
    window = blob_window()
    first = FakeStore(window)
    wired(first)
    job.fit_project("p", "daily")
    written = first.written[0]
    members: dict[str, set[str]] = {}
    for i, label in enumerate(written["labels"]):
        if label >= 0:
            members.setdefault(written["group_ids"][label], set()).add(window.trace_ids[i])
    previous = PreviousFit(
        "fit1",
        {
            g["group_id"]: {"name": g["name"], "description": g["description"], "size": g["size"]}
            for g in written["groups"]
        },
        members,
        set(window.trace_ids),
    )
    second = FakeStore(window, previous=previous)
    calls = wired(second)
    out = job.fit_project("p", "refresh")
    assert out.kept_ids == 3 and out.new_ids == 0 and not calls
    assert {g["group_id"] for g in second.written[0]["groups"]} == set(written["group_ids"])
    assert {g["name"] for g in second.written[0]["groups"]} == {
        g["name"] for g in written["groups"]
    }


def test_a_failure_is_recorded_on_the_run(wired, monkeypatch):
    store = FakeStore(blob_window())
    wired(store)
    monkeypatch.setattr(
        job, "fit_groups", lambda *a, **k: (_ for _ in ()).throw(RuntimeError("boom"))
    )
    out = job.fit_project("p", "daily", FitParams())
    assert out.status == "failed"
    assert store.finished[0][1]["status"] == "failed" and "boom" in store.finished[0][1]["error"]


def test_a_name_already_in_use_is_asked_for_again_with_the_used_names(monkeypatch):
    seen = []

    def fake_name(summaries, taken, *, api_key, client=None):
        seen.append(list(taken))
        # The first answer repeats a name in use; the retry gives a different one.
        return GroupName("Refunds" if len(seen) <= 2 else "Order Changes", "d", 0.001)

    monkeypatch.setattr(job, "name_group", fake_name)
    names, cost = job._name_new_groups([(0, ["a"]), (1, ["b"])], ["Refunds"], "k")
    assert names[0][0] != "Refunds" or names[1][0] != "Refunds"
    assert cost > 0 and any("Refunds" in taken for taken in seen[2:])


def test_due_fits_prefers_a_pending_refresh_over_the_daily_run(monkeypatch):
    monkeypatch.setattr(job.store, "utc_now", lambda: datetime(2026, 11, 8, 12, tzinfo=UTC))
    monkeypatch.setattr(job.store, "enabled_projects", lambda: ["a", "b", "c"])
    monkeypatch.setattr(job.store, "refresh_pending", lambda p: p == "a")
    monkeypatch.setattr(job.store, "daily_due", lambda p, day: p in ("a", "b"))
    assert job.due_fits() == [("a", "refresh"), ("b", "daily")]


def test_a_window_that_turns_out_too_small_is_skipped_without_a_fit(wired, monkeypatch):
    store = FakeStore(blob_window())
    wired(store)
    monkeypatch.setattr(job, "fit_groups", lambda *a, **k: None)
    out = job.fit_project("p", "daily")
    assert out.status == "skipped" and out.reason == "too_few_summaries"
    assert not store.written
