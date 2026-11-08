"""The corpus cleaner removes exactly the corpus's traces from every table that holds them."""

from unittest.mock import MagicMock

from scripts.topic_corpus import clean as clean_module
from scripts.topic_corpus.generate import CorpusParams, build_corpus


def test_every_table_is_cleaned_for_the_project_in_chunks(monkeypatch):
    client = MagicMock()
    monkeypatch.setattr("db.clickhouse.client.get_clickhouse_client", lambda: client)
    monkeypatch.setattr(clean_module, "CHUNK", 100)
    corpus = build_corpus(CorpusParams(seed=3, topics=1, min_per_topic=40, max_per_topic=40))
    removed = clean_module.clean_corpus(corpus, project_id="proj-x")
    assert removed == len(corpus.traces)

    chunks = -(-len(corpus.traces) // 100)
    calls = client.query.call_args_list
    assert len(calls) == chunks * len(clean_module.TABLES)
    deleted_ids: set[str] = set()
    for call in calls:
        sql = call.args[0]
        assert sql.startswith("ALTER TABLE ") and "DELETE WHERE project_id" in sql
        assert call.kwargs["parameters"]["project_id"] == "proj-x"
        deleted_ids |= set(call.kwargs["parameters"]["ids"])
    assert deleted_ids == {t.trace_id for t in corpus.traces}
    assert {c.args[0].split()[2] for c in calls} == set(clean_module.TABLES)


def test_the_summary_and_group_tables_are_among_those_cleaned():
    assert {"trace_task_digests", "trace_group_members", "traces", "spans"} <= set(
        clean_module.TABLES
    )
