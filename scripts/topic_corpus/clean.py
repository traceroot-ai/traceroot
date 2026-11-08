"""Remove a corpus's traces (by the ids its seed gives) and every topic row that
refers to them. Uses the backend's ClickHouse settings; only for development and
evaluation projects."""

from __future__ import annotations

from scripts.topic_corpus.generate import Corpus

# Tables keyed by (project_id, trace_id).
TABLES = ("spans", "traces", "trace_task_digests", "trace_group_members")
CHUNK = 500


def clean_corpus(corpus: Corpus, *, project_id: str) -> int:
    from db.clickhouse.client import get_clickhouse_client

    ch = get_clickhouse_client()
    ids = [t.trace_id for t in corpus.traces]
    for i in range(0, len(ids), CHUNK):
        chunk = ids[i : i + CHUNK]
        for table in TABLES:
            # ALTER ... DELETE rather than a lightweight DELETE: spans carries projections,
            # which a lightweight delete refuses. mutations_sync waits for it to finish.
            ch.query(
                f"ALTER TABLE {table} DELETE WHERE project_id = {{project_id:String}} "
                "AND trace_id IN {ids:Array(String)} SETTINGS mutations_sync = 2",
                parameters={"project_id": project_id, "ids": chunk},
            )
    return len(ids)
