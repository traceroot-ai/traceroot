"""The coding-agent insights queries stay valid for the public SQL gateway.

Each query is rendered and run through the gateway's own validator and rewriter
(no database): that checks syntax, the function allowlist and the time-window
rewrite. It does not check the data; the queries are also run against a real
project when the feature is verified end to end.
"""

import importlib.util
from pathlib import Path

import pytest

from rest.services.sql.rewriter import scope_and_render

RUNNER = (
    Path(__file__).resolve().parent.parent / "scripts" / "coding_agent_insights" / "run_queries.py"
)
_spec = importlib.util.spec_from_file_location("coding_agent_run_queries", RUNNER)
runner = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(runner)

PROJECT = "00000000-0000-0000-0000-000000000000"


def _render(name: str) -> str:
    return runner.render(name, 7, repo="org/repo", tool="Bash", ids=["trace-a", "trace-b"])


def test_every_query_is_present():
    assert len(runner.query_names()) == 10


@pytest.mark.parametrize("name", runner.query_names())
def test_query_passes_the_gateway_validator(name):
    sql, _params = scope_and_render(_render(name), PROJECT)
    assert sql


@pytest.mark.parametrize("name", runner.query_names())
def test_query_is_time_bounded_and_never_reads_content(name):
    sql = "\n".join(line for line in _render(name).splitlines() if not line.startswith("--"))
    assert "INTERVAL 7 DAY" in sql
    assert "span_start_time" in sql or "trace_start_time" in sql
    for column in ("input", "output"):
        assert f"{column}," not in sql and f" {column} " not in sql


def test_window_is_rewritten():
    assert "INTERVAL 30 DAY" in runner.render("q01_turns_per_day", 30)
    assert "INTERVAL 7 DAY" not in runner.render("q01_turns_per_day", 30)


def test_placeholders_are_filled_and_unsafe_values_refused():
    sql = runner.render("q09_comparison_group", 7, repo="org/repo", ids=["a1", "b2"])
    assert "IN ('a1','b2')" in sql and "git_repo = 'org/repo'" in sql
    with pytest.raises(SystemExit):
        runner.render("q09_comparison_group", 7, repo="x' OR '1'='1", ids=["a"])
    with pytest.raises(SystemExit):
        runner.render("q09_comparison_group", 7, repo="org/repo", ids=["a'; DROP"])
    with pytest.raises(SystemExit):
        runner.render("q10_monitor_failure_rate", 7, repo="org/repo")


def test_assistant_prompt_is_filled():
    text = runner.filled_prompt("retry loops in org/repo", 14, ["t1", "t2"])
    assert "retry loops in org/repo" in text and "last 14 days" in text and "t1, t2" in text
    assert "<dates>" not in text
    assert "never name or compare individual developers" in text


def test_prompt_lists_exactly_the_public_columns():
    """The monitor-query step names every public column, so a schema change updates the prompt."""
    from rest.services.sql.schema import PUBLIC_TABLES

    item = next(
        line for line in runner.PROMPT_PATH.read_text().splitlines() if line.startswith("6. ")
    )
    for table in PUBLIC_TABLES.values():
        listed = item.split(f"{table.name}: ", 1)[1].split(".", 1)[0]
        assert [c.strip() for c in listed.split(",")] == [c.name for c in table.columns]
    sample = item.split("Follow the shape of this query: ", 1)[1].rstrip(".")
    scope_and_render(sample, PROJECT)
