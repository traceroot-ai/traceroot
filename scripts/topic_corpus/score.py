"""Score a fit against the corpus manifest.

Only traces that were summarized are scored (a sampled project may skip some).
Each trace's truth is its manifest label; its prediction is the group it is in,
or "" for none.

Criteria (all measured on the planted traces unless noted):

- ``ari``: adjusted Rand index between planted label and group, with "no group"
  counted as one extra cluster, so leaving traces out costs score.
- ``topic_recall``: per planted topic, the share of its traces that sit in the
  single group holding most of them.
- ``mixed_groups``: groups where two or more planted topics each make up more
  than ``MIX_SHARE`` of the group.
- ``unassigned_share``: planted traces in no group.
- ``noise_unassigned_share`` (information): true-noise traces in no group.
"""

from __future__ import annotations

import json
from collections import Counter, defaultdict
from dataclasses import dataclass, field

from sklearn.metrics import adjusted_rand_score

MIN_ARI = 0.7
MIN_TOPIC_RECALL = 0.8
MIX_SHARE = 0.3
MAX_UNASSIGNED_SHARE = 0.2
NOISE_LABEL = "noise"


@dataclass
class Score:
    traces_scored: int
    planted_scored: int
    ari: float
    topic_recall: dict[str, float]
    worst_topic_recall: float
    groups: int
    mixed_groups: list[dict] = field(default_factory=list)
    unassigned_share: float = 0.0
    noise_unassigned_share: float | None = None
    # Which planted topic each group mostly holds, with its share of the group.
    group_majority: dict[str, tuple[str, float]] = field(default_factory=dict)

    @property
    def passes(self) -> bool:
        return (
            self.ari >= MIN_ARI
            and self.worst_topic_recall >= MIN_TOPIC_RECALL
            and not self.mixed_groups
            and self.unassigned_share <= MAX_UNASSIGNED_SHARE
        )

    def to_dict(self) -> dict:
        return {
            "traces_scored": self.traces_scored,
            "planted_scored": self.planted_scored,
            "ari": round(self.ari, 4),
            "topic_recall": {k: round(v, 4) for k, v in sorted(self.topic_recall.items())},
            "worst_topic_recall": round(self.worst_topic_recall, 4),
            "groups": self.groups,
            "mixed_groups": self.mixed_groups,
            "unassigned_share": round(self.unassigned_share, 4),
            "noise_unassigned_share": (
                None
                if self.noise_unassigned_share is None
                else round(self.noise_unassigned_share, 4)
            ),
            "thresholds": {
                "ari>=": MIN_ARI,
                "topic_recall>=": MIN_TOPIC_RECALL,
                "mix_share": MIX_SHARE,
                "unassigned_share<=": MAX_UNASSIGNED_SHARE,
            },
            "passes": self.passes,
        }


def score(manifest: dict, assignments: dict[str, str]) -> Score:
    """Score ``assignments`` (trace id -> group id, "" for none) against ``manifest``."""
    truth = {t["trace_id"]: t["label"] for t in manifest["traces"]}
    scored = {tid: assignments[tid] for tid in truth if tid in assignments}
    planted = {tid: g for tid, g in scored.items() if truth[tid] != NOISE_LABEL}
    noise = [g for tid, g in scored.items() if truth[tid] == NOISE_LABEL]

    ids = sorted(planted)
    ari = (
        adjusted_rand_score([truth[t] for t in ids], [planted[t] or "<none>" for t in ids])
        if ids
        else 0.0
    )

    by_topic: dict[str, Counter] = defaultdict(Counter)
    by_group: dict[str, Counter] = defaultdict(Counter)
    for tid in ids:
        by_topic[truth[tid]][planted[tid]] += 1
        if planted[tid]:
            by_group[planted[tid]][truth[tid]] += 1

    recall = {}
    for topic, counts in by_topic.items():
        total = sum(counts.values())
        best = max((n for g, n in counts.items() if g), default=0)
        recall[topic] = best / total if total else 0.0

    mixed = []
    majority = {}
    for gid, counts in by_group.items():
        size = sum(counts.values())
        top, top_n = counts.most_common(1)[0]
        majority[gid] = (top, round(top_n / size, 4))
        heavy = {t: round(n / size, 4) for t, n in counts.items() if n / size > MIX_SHARE}
        if len(heavy) >= 2:
            mixed.append({"group": gid, "size": size, "topics": heavy})

    return Score(
        traces_scored=len(scored),
        planted_scored=len(ids),
        ari=ari,
        topic_recall=recall,
        worst_topic_recall=min(recall.values()) if recall else 0.0,
        groups=len(by_group),
        mixed_groups=mixed,
        unassigned_share=(sum(1 for g in planted.values() if not g) / len(ids)) if ids else 0.0,
        noise_unassigned_share=(sum(1 for g in noise if not g) / len(noise)) if noise else None,
        group_majority=majority,
    )


def load_assignments(project_id: str) -> dict[str, str]:
    """Latest placement of every digested trace of the project, from ClickHouse."""
    from db.clickhouse.client import get_clickhouse_client

    ch = get_clickhouse_client()
    result = ch.query(
        """
        SELECT d.trace_id, m.group_id
        FROM (SELECT trace_id FROM trace_task_digests FINAL
              WHERE project_id = {p:String} AND lens = 'task') AS d
        LEFT JOIN (SELECT trace_id, group_id FROM trace_group_members FINAL
                   WHERE project_id = {p:String} AND lens = 'task') AS m USING (trace_id)
        """,
        parameters={"p": project_id},
    )
    return {tid: gid or "" for tid, gid in result.result_rows}


def assignments_from_file(path: str) -> dict[str, str]:
    """Read ``{"assignments": {trace_id: group_id}}``, as the incremental baseline writes it."""
    with open(path) as f:
        data = json.load(f)
    return {tid: gid or "" for tid, gid in data["assignments"].items()}


def main(argv: list[str] | None = None) -> int:
    import argparse

    parser = argparse.ArgumentParser(prog="score", description=__doc__)
    parser.add_argument(
        "--manifest", required=True, nargs="+", help="manifest file(s) of the project"
    )
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--project-id", help="score the project's current groups in ClickHouse")
    source.add_argument("--assignments", help="score an assignments file (trace id -> group id)")
    args = parser.parse_args(argv)
    manifest: dict = {"traces": []}
    for path in args.manifest:
        with open(path) as f:
            manifest["traces"].extend(json.load(f)["traces"])
    assignments = (
        load_assignments(args.project_id)
        if args.project_id
        else assignments_from_file(args.assignments)
    )
    result = score(manifest, assignments)
    print(json.dumps(result.to_dict(), indent=2))
    return 0 if result.passes else 1


if __name__ == "__main__":
    raise SystemExit(main())
