"""Export a project's summaries and embeddings to a JSON file, for offline comparisons.

    python -m scripts.topic_corpus.export_digests --project-id <id> --out digests.json

Each entry has trace_id, trace_time_ms, summary and embedding. The file is the input of
the incremental baseline (frontend/worker/src/ee/task-groups/eval/run-incremental.ts).
"""

from __future__ import annotations

import argparse
import json


def export_digests(project_id: str) -> list[dict]:
    from db.clickhouse.client import get_clickhouse_client

    result = get_clickhouse_client().query(
        """
        SELECT trace_id, toUnixTimestamp64Milli(trace_time), summary, embedding
        FROM trace_task_digests FINAL
        WHERE project_id = {p:String} AND lens = 'task'
        ORDER BY trace_time, trace_id
        """,
        parameters={"p": project_id},
    )
    return [
        {"trace_id": t, "trace_time_ms": int(ms), "summary": s, "embedding": list(e)}
        for t, ms, s, e in result.result_rows
    ]


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="export_digests", description=__doc__)
    parser.add_argument("--project-id", required=True)
    parser.add_argument("--out", required=True)
    args = parser.parse_args(argv)
    rows = export_digests(args.project_id)
    with open(args.out, "w") as f:
        json.dump(rows, f)
    print(f"wrote {len(rows)} summaries to {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
