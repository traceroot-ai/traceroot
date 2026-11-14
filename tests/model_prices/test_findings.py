"""Tests for comparing two reports: a PR that stops comparing a row hides its findings
rather than clearing them, and one that changes a flagged rate to another wrong rate
does not clear it."""

from scripts.model_prices.catalogs import index_litellm, index_modelsdev
from scripts.model_prices.checks import build_report
from scripts.model_prices.slack import build_payload
from scripts.model_prices.tracking import track
from tests.model_prices.samples import (
    DATE,
    LITELLM_FILLER,
    _track_one_pr,
    ll_entry,
    md_catalog,
    row,
)


def test_a_pr_that_stops_comparing_a_flagged_row_does_not_fix_it():
    # A provider no catalog covers hides the row's flags rather than fixing them.
    rows = [row("deepseek-d", "deepseek", input_=5e-7, output=1e-6)]
    litellm = {"deepseek/deepseek-d": ll_entry("deepseek", input_=1e-6, output=2e-6)}
    catalogs = (index_litellm({**LITELLM_FILLER, **litellm}), index_modelsdev(md_catalog()))

    def evaluate(pr_rows):
        return build_report(pr_rows, *catalogs, date=DATE, min_compared=0)

    report = evaluate(rows)
    track(report, [{"number": 7, "report": evaluate([{**rows[0], "provider": "typesafe"}])}])

    assert [(f["field"], f["tracked_by"]) for f in report["flagged"]] == [
        ("input", []),
        ("output", []),
    ]
    [pr] = report["pull_requests"]
    assert (pr["fixes"], pr["adds"]) == ([], ["deepseek-d no longer compared with the catalogs"])


def test_a_pr_that_stops_comparing_a_row_does_not_fix_its_1m_id():
    # The [1m] ID is expected only while a catalog lists the row's model with 1M tokens.
    rows = [row("claude-l", "anthropic")]
    litellm = {"claude-l": ll_entry("anthropic", max_input_tokens=1_000_000)}
    report = _track_one_pr(rows, litellm, [{**rows[0], "provider": "typesafe"}])

    assert report["unpriced_ids"][0]["tracked_by"] == []
    [pr] = report["pull_requests"]
    assert (pr["fixes"], pr["adds"]) == ([], ["claude-l no longer compared with the catalogs"])


def test_a_pr_that_stops_comparing_a_row_does_not_fix_its_long_context_rate():
    rows = [row("gpt-r", "openai")]
    litellm = {"gpt-r": ll_entry("openai", input_cost_per_token_above_272k_tokens=2e-6)}
    report = _track_one_pr(rows, litellm, [{**rows[0], "provider": "typesafe"}])

    assert report["long_context"][0]["tracked_by"] == []
    [pr] = report["pull_requests"]
    assert (pr["fixes"], pr["adds"]) == ([], ["gpt-r no longer compared with the catalogs"])


def test_a_pr_that_stops_comparing_a_row_does_not_fix_what_its_pattern_prices():
    pattern = r"(?i)^claude-f(-[\d-]+)?$"
    rows = [row("claude-f", "anthropic", input_=1e-5, pattern=pattern)]
    litellm = {
        "claude-f": ll_entry("anthropic", input_=1e-5),
        "claude-f-2": ll_entry("anthropic", input_=8e-6),
    }
    moved = row("claude-f", "typesafe", input_=8e-6, pattern=pattern)
    report = _track_one_pr(rows, litellm, [moved])

    assert [(f["model"], f["priced_as"], f["tracked_by"]) for f in report["flagged"]] == [
        ("claude-f-2", "claude-f", [])
    ]
    [pr] = report["pull_requests"]
    assert (pr["fixes"], pr["adds"]) == ([], ["claude-f no longer compared with the catalogs"])

    # A row no catalog listed to begin with is not hidden by the PR, so its fix counts.
    del litellm["claude-f"]
    fixed = row("claude-f", "anthropic", input_=8e-6, pattern=pattern)
    assert _track_one_pr(rows, litellm, [fixed])["flagged"][0]["tracked_by"] == [7]


def test_a_pr_that_changes_a_flagged_rate_to_another_wrong_one_does_not_fix_it():
    litellm = {"deepseek/deepseek-d": ll_entry("deepseek", output=4e-6)}
    rows = [row("deepseek-d", "deepseek", output=1e-6)]
    report = _track_one_pr(rows, litellm, [row("deepseek-d", "deepseek", output=1e-4)])

    assert report["flagged"][0]["tracked_by"] == []
    [pr] = report["pull_requests"]
    assert (pr["fixes"], pr["adds"]) == ([], ["deepseek-d output rate (ours 100.00)"])
    # The flag stays in the message as needing a fix, so its header can't turn green.
    assert build_payload(report)["text"].endswith(": 1 model with prices to check")
