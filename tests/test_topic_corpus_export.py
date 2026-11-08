"""The digest export used by the offline comparisons."""

import json
from unittest.mock import MagicMock

from scripts.topic_corpus import export_digests as export_module


def test_rows_become_plain_json_entries_scoped_to_the_project(monkeypatch):
    client = MagicMock()
    client.query.return_value.result_rows = [("t1", 1000, "Book a flight.", (0.1, 0.2))]
    monkeypatch.setattr("db.clickhouse.client.get_clickhouse_client", lambda: client)
    rows = export_module.export_digests("proj")
    assert rows == [
        {
            "trace_id": "t1",
            "trace_time_ms": 1000,
            "summary": "Book a flight.",
            "embedding": [0.1, 0.2],
        }
    ]
    assert client.query.call_args.kwargs["parameters"] == {"p": "proj"}


def test_the_command_writes_the_file(monkeypatch, tmp_path, capsys):
    monkeypatch.setattr(export_module, "export_digests", lambda project_id: [{"trace_id": "t"}])
    out = tmp_path / "d.json"
    assert export_module.main(["--project-id", "p", "--out", str(out)]) == 0
    assert json.loads(out.read_text()) == [{"trace_id": "t"}]
    assert "wrote 1 summaries" in capsys.readouterr().out
