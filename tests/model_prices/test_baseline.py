"""Tests for --baseline: what an edit to the price file fixes and adds, compared with a
report saved before it, and the same adds that --track lists for an open PR."""

import json

import pytest

from scripts.model_prices.findings import compare_reports
from tests.model_prices.samples import (
    DATE,
    _block_text,
    ll_entry,
    md_catalog,
    md_model,
    report_for,
    row,
    runner,
)


@pytest.fixture
def run(tmp_path, monkeypatch):
    """Run main() against sample data, as runner describes."""
    return runner(tmp_path, monkeypatch)


def compare(before, after, litellm, modelsdev):
    """What --baseline lists for an edit from the before rows to the after rows."""
    return compare_reports(
        report_for(before, litellm, modelsdev), report_for(after, litellm, modelsdev)
    )


def test_baseline_lists_what_an_edit_fixes_and_adds():
    litellm = {
        "deepseek/deepseek-d": ll_entry("deepseek", input_=1e-6),
        "claude-f": ll_entry("anthropic"),
        "claude-f-2": ll_entry("anthropic", input_=8e-6),
    }
    before = [
        row("deepseek-d", "deepseek", input_=5e-7),
        row("claude-f", "anthropic"),
        row("claude-f-2", "anthropic", input_=8e-6),
    ]
    # The edit fixes the DeepSeek rate, and widens the older Claude row's pattern to
    # price the newer version's dated snapshot, which no row matched. That snapshot now
    # gets the older version's rate, the mistake the check exists to catch.
    after = [
        row("deepseek-d", "deepseek", input_=1e-6),
        row("claude-f", "anthropic", pattern=r"(?i)^claude-f(-[\d-]+)?$"),
        before[2],
    ]
    litellm["claude-f-2-20260101"] = ll_entry("anthropic", input_=8e-6)

    assert compare(before, after, litellm, md_catalog()) == {
        "fixes": ["deepseek-d input rate (ours 0.50)", "claude-f-2-20260101 not priced"],
        "adds": ["claude-f-2-20260101 input rate (ours 1.00)"],
    }


def test_an_id_that_goes_from_no_price_to_another_rows_price_is_added_not_fixed():
    litellm = {"claude-f": ll_entry("anthropic"), "us.anthropic.claude-f-2": ll_entry("bedrock")}
    before = [
        row("claude-f", "anthropic", pattern=r"(?i)^claude-f$"),
        row("claude-f-2", "anthropic", input_=8e-6),
    ]
    after = [
        row("claude-f", "anthropic", pattern=r"(?i)^(us\.anthropic\.)?claude-f(-[\d-]+)?$"),
        before[1],
    ]

    assert compare(before, after, litellm, md_catalog()) == {
        "fixes": [],
        "adds": ["us.anthropic.claude-f-2 priced as claude-f"],
    }


def test_a_flagged_rate_changed_to_another_wrong_rate_is_added_not_fixed():
    litellm = {"deepseek/deepseek-d": ll_entry("deepseek", output=4e-6)}
    before = [row("deepseek-d", "deepseek", output=1e-6)]
    worse = [row("deepseek-d", "deepseek", output=1e-4)]
    fixed = [row("deepseek-d", "deepseek", output=4e-6)]

    assert compare(before, worse, litellm, md_catalog()) == {
        "fixes": [],
        "adds": ["deepseek-d output rate (ours 100.00)"],
    }
    assert compare(before, fixed, litellm, md_catalog()) == {
        "fixes": ["deepseek-d output rate (ours 1.00)"],
        "adds": [],
    }


def test_an_edit_that_stops_comparing_a_flagged_row_is_added():
    # A provider no catalog covers hides the row's flag rather than fixing it.
    litellm = {
        "deepseek/deepseek-d": ll_entry("deepseek", output=4e-6),
        "claude-f": ll_entry("anthropic"),
    }
    before = [row("deepseek-d", "deepseek", output=1e-6), row("claude-f", "anthropic")]
    after = [row("deepseek-d", "typesafe", output=1e-6), before[1]]

    assert compare(before, after, litellm, md_catalog()) == {
        "fixes": [],
        "adds": ["deepseek-d no longer compared with the catalogs"],
    }


def test_a_host_id_newly_priced_below_the_hosts_rates_is_added():
    # GovCloud and regional profiles bill more than the model's own rates. A GovCloud
    # region's route lists the plain Bedrock ID at its price too; the bare key wins.
    litellm = {
        "claude-k-5": ll_entry("anthropic", input_=2e-6, output=1e-5),
        "anthropic.claude-k-5": ll_entry("bedrock_converse", input_=2e-6, output=1e-5),
        "us-gov.anthropic.claude-k-5": ll_entry("bedrock_converse", input_=2.4e-6, output=1.2e-5),
        "bedrock/us-gov-west-1/anthropic.claude-k-5": ll_entry(
            "bedrock", input_=2.4e-6, output=1.2e-5
        ),
    }
    bedrock = {"in.anthropic.claude-k-5": md_model(input_=2.2e-6, output=1.1e-5)}
    modelsdev = md_catalog(**{"amazon-bedrock": bedrock})
    before = [row("claude-k-5", "anthropic", input_=2e-6, output=1e-5)]
    pattern = r"(?i)^(((us-gov|in)\.)?anthropic\.)?claude-k-5$"
    after = [row("claude-k-5", "anthropic", input_=2e-6, output=1e-5, pattern=pattern)]

    assert compare(before, after, litellm, modelsdev)["adds"] == [
        "in.anthropic.claude-k-5 priced at claude-k-5's rates, but the host lists "
        "input 2.20 (ours 2.00) and output 11.00 (ours 10.00)",
        "us-gov.anthropic.claude-k-5 priced at claude-k-5's rates, but the host lists "
        "input 2.40 (ours 2.00) and output 12.00 (ours 10.00)",
    ]


def test_fixing_a_rate_adds_nothing_for_a_host_id_its_row_already_priced():
    # The row already prices its GovCloud ID below the host's rates. Fixing the row's
    # output rate changes ours for that ID too, but the edit does not price it anew.
    litellm = {
        "claude-k-5": ll_entry("anthropic", input_=2e-6, output=1e-5),
        "us-gov.anthropic.claude-k-5": ll_entry("bedrock_converse", input_=2.4e-6, output=1.2e-5),
    }
    pattern = r"(?i)^(us-gov\.anthropic\.)?claude-k-5$"
    before = [row("claude-k-5", "anthropic", input_=2e-6, output=2e-5, pattern=pattern)]
    after = [row("claude-k-5", "anthropic", input_=2e-6, output=1e-5, pattern=pattern)]

    assert compare(before, after, litellm, md_catalog()) == {
        "fixes": ["claude-k-5 output rate (ours 20.00)"],
        "adds": [],
    }


def test_a_host_id_another_row_takes_over_at_the_same_rates_is_not_added():
    # A row split off a broader one prices that row's host IDs at the same rates, so
    # what their spans record does not change.
    litellm = {
        "claude-s-4": ll_entry("anthropic", input_=3e-6, output=1.5e-5),
        "claude-s-4-6": ll_entry("anthropic", input_=3e-6, output=1.5e-5),
        "us.anthropic.claude-s-4-6": ll_entry("bedrock_converse", input_=3.3e-6, output=1.65e-5),
    }
    broad = r"(?i)^((us\.)?anthropic\.)?claude-s-4(-[\d-]+)?$"
    before = [row("claude-s-4", "anthropic", input_=3e-6, output=1.5e-5, pattern=broad)]
    split = r"(?i)^((us\.)?anthropic\.)?claude-s-4-6$"
    after = [
        row("claude-s-4", "anthropic", input_=3e-6, output=1.5e-5),
        row("claude-s-4-6", "anthropic", input_=3e-6, output=1.5e-5, pattern=split),
    ]

    assert compare(before, after, litellm, md_catalog()) == {"fixes": [], "adds": []}


def test_a_new_row_that_prices_host_ids_below_the_hosts_rates_is_added():
    # A row for a model no row priced, whose pattern also takes Bedrock's regional and
    # GovCloud profiles, prices them at the model's own rates.
    litellm = {
        "claude-a": ll_entry("anthropic"),
        "claude-k-6": ll_entry("anthropic", input_=2e-6, output=1e-5),
        "us.anthropic.claude-k-6": ll_entry("bedrock_converse", input_=2.2e-6, output=1.1e-5),
        "us-gov.anthropic.claude-k-6": ll_entry("bedrock_converse", input_=2.4e-6, output=1.2e-5),
    }
    before = [row("claude-a", "anthropic")]
    pattern = r"(?i)^(((us|us-gov)\.)?anthropic\.)?claude-k-6$"
    after = [*before, row("claude-k-6", "anthropic", input_=2e-6, output=1e-5, pattern=pattern)]

    assert compare(before, after, litellm, md_catalog()) == {
        "fixes": ["claude-k-6 not priced"],
        "adds": [
            "us-gov.anthropic.claude-k-6 priced at claude-k-6's rates, but the host lists "
            "input 2.40 (ours 2.00) and output 12.00 (ours 10.00)",
            "us.anthropic.claude-k-6 priced at claude-k-6's rates, but the host lists "
            "input 2.20 (ours 2.00) and output 11.00 (ours 10.00)",
        ],
    }


def test_an_id_moved_off_a_wrong_row_to_its_own_below_the_hosts_rates_is_added():
    litellm = {
        "claude-k-5": ll_entry("anthropic", input_=2e-6, output=1e-5),
        "claude-j": ll_entry("anthropic", input_=9e-6),
        "us-gov.anthropic.claude-k-5": ll_entry("bedrock_converse", input_=2.4e-6, output=1.2e-5),
    }
    wrong = r"(?i)^(claude-j|us-gov\.anthropic\.claude-k-5)$"
    before = [
        row("claude-k-5", "anthropic", input_=2e-6, output=1e-5),
        row("claude-j", "anthropic", input_=9e-6, pattern=wrong),
    ]
    own = r"(?i)^(us-gov\.anthropic\.)?claude-k-5$"
    after = [
        row("claude-k-5", "anthropic", input_=2e-6, output=1e-5, pattern=own),
        row("claude-j", "anthropic", input_=9e-6),
    ]

    assert compare(before, after, litellm, md_catalog()) == {
        "fixes": ["us-gov.anthropic.claude-k-5 priced as claude-j"],
        "adds": [
            "us-gov.anthropic.claude-k-5 priced at claude-k-5's rates, but the host lists "
            "input 2.40 (ours 2.00) and output 12.00 (ours 10.00)"
        ],
    }


def test_a_host_id_newly_priced_at_its_hosts_input_and_output_rates_is_not_added():
    # Only a host's input and output rates are compared with the row that prices its ID.
    litellm = {
        "claude-k-5": ll_entry("anthropic", input_=2e-6, output=1e-5),
        "us.anthropic.claude-k-5": ll_entry(
            "bedrock_converse",
            input_=2e-6,
            output=1e-5,
            cache_read=2e-7,
            cache_creation_input_token_cost=2.5e-6,
        ),
    }
    before = [row("claude-k-5", "anthropic", input_=2e-6, output=1e-5)]
    pattern = r"(?i)^(us\.anthropic\.)?claude-k-5$"
    after = [row("claude-k-5", "anthropic", input_=2e-6, output=1e-5, pattern=pattern)]

    assert compare(before, after, litellm, md_catalog()) == {
        "fixes": ["us.anthropic.claude-k-5 not priced by its row"],
        "adds": [],
    }


def test_a_dash_spelling_that_loses_its_price_is_added():
    # Gateways send grok-q-20 for grok-q.20. The grok-q row's loose suffix prices it at
    # the right rate, and grok-q-6 at the wrong one. Narrowing grok-q leaves both unpriced
    # unless their own rows take the dash spelling, and no other finding would show it.
    litellm = {
        "xai/grok-q": ll_entry("xai"),
        "xai/grok-q.20": ll_entry("xai"),
        "xai/grok-q.6": ll_entry("xai", input_=5e-6),
    }
    before = [
        row("grok-q", "xai", pattern=r"(?i)^(xai\/)?grok-q(-[\d-]+)?$"),
        row("grok-q.20", "xai", pattern=r"(?i)^(xai\/)?grok-q\.20$"),
        row("grok-q.6", "xai", input_=5e-6, pattern=r"(?i)^(xai\/)?grok-q\.6$"),
    ]
    narrowed = [row("grok-q", "xai", pattern=r"(?i)^(xai\/)?grok-q(-\d{4})?$"), *before[1:]]
    extended = [
        narrowed[0],
        row("grok-q.20", "xai", pattern=r"(?i)^(xai\/)?grok-q[.-]20$"),
        row("grok-q.6", "xai", input_=5e-6, pattern=r"(?i)^(xai\/)?grok-q[.-]6$"),
    ]

    assert compare(before, narrowed, litellm, md_catalog()) == {
        "fixes": ["grok-q-6 input rate (ours 1.00)"],
        "adds": [
            "grok-q-20 no longer priced (was grok-q)",
            "grok-q-6 no longer priced (was grok-q)",
        ],
    }
    assert compare(before, extended, litellm, md_catalog()) == {
        "fixes": ["grok-q-6 input rate (ours 1.00)"],
        "adds": [],
    }


def test_baseline_exit_codes(run, tmp_path):
    litellm = {"gpt-a": ll_entry("openai", input_=2e-6), "gpt-b": ll_entry("openai")}
    baseline = tmp_path / "before.json"
    before = [row("gpt-a", "openai"), row("gpt-b", "openai")]
    baseline.write_text(json.dumps(report_for(before, litellm, md_catalog())))
    args = ("--min-compared", "1", "--baseline", str(baseline))

    fixed = [row("gpt-a", "openai", input_=2e-6), row("gpt-b", "openai")]
    code, _, report = run(fixed, litellm, md_catalog(), *args)
    assert code == 0
    assert report["baseline"] == {"fixes": ["gpt-a input rate (ours 1.00)"], "adds": []}

    broke = [row("gpt-a", "openai"), row("gpt-b", "openai", input_=9e-6)]
    code, _, report = run(broke, litellm, md_catalog(), *args)
    assert code == 2
    assert report["baseline"]["adds"] == ["gpt-b input rate (ours 9.00)"]

    baseline.write_text(json.dumps({"date": DATE, "status": "failed", "error": "x"}))
    code, posted, _ = run(fixed, litellm, md_catalog(), *args)
    assert code == 1
    assert "the baseline report is not from a completed run" in posted[-1]["text"]


@pytest.mark.parametrize("key", ["dash_spellings", "host_rates", "date"])
def test_a_baseline_from_another_version_fails_the_run(run, tmp_path, key):
    # Without its dash spellings or host rates, an edit that stops pricing a dash
    # spelling, or prices a host ID at the wrong rate, would pass unseen.
    litellm = {"gpt-a": ll_entry("openai")}
    rows = [row("gpt-a", "openai")]
    saved = report_for(rows, litellm, md_catalog())
    del saved[key]
    baseline = tmp_path / "before.json"
    baseline.write_text(json.dumps(saved))

    code, posted, _ = run(
        rows, litellm, md_catalog(), "--min-compared", "1", "--baseline", str(baseline)
    )

    assert code == 1
    assert "the baseline report was written by a different version" in posted[-1]["text"]


def test_baseline_compares_at_the_baseline_reports_date(run, tmp_path):
    # gpt-old retires after the baseline was saved. Checked at today's date it would drop
    # out of the missing models and read as a fix the price file never made.
    litellm = {
        "gpt-a": ll_entry("openai"),
        "gpt-old": ll_entry("openai", deprecation_date="2026-11-09"),
    }
    rows = [row("gpt-a", "openai")]
    baseline = tmp_path / "before.json"
    baseline.write_text(json.dumps(report_for(rows, litellm, md_catalog())))

    code, _, report = run(
        rows, litellm, md_catalog(), "--min-compared", "1", "--baseline", str(baseline)
    )

    assert code == 0
    assert report["date"] == DATE
    assert report["baseline"] == {"fixes": [], "adds": []}


def test_baseline_lists_each_add_on_its_own_line(run, tmp_path, capsys):
    # Adds are checked line by line against the kinds allowed, such as a rate a new row
    # leaves out, so one model's rates are not merged into one line.
    litellm = {
        "gpt-a": ll_entry("openai"),
        "claude-x": ll_entry(
            "anthropic", cache_read=3e-7, cache_creation_input_token_cost_above_1hr=6e-6
        ),
    }
    before = [row("gpt-a", "openai")]
    baseline = tmp_path / "before.json"
    baseline.write_text(json.dumps(report_for(before, litellm, md_catalog())))
    after = [*before, row("claude-x", "anthropic", cache_read=8e-7)]

    code, _, report = run(
        after, litellm, md_catalog(), "--min-compared", "1", "--baseline", str(baseline)
    )

    adds = ["claude-x cache read rate (ours 0.80)", "claude-x cache write 1h rate (ours none)"]
    assert code == 2
    assert report["baseline"] == {"fixes": ["claude-x not priced"], "adds": adds}
    listed = "\n".join(f"• {add}" for add in adds)
    assert (
        f"*Compared with the baseline, this file adds* (2)\n{listed}\n" in capsys.readouterr().out
    )


def test_track_lists_the_host_rates_and_dash_spellings_a_pr_would_add(run):
    litellm = {
        "xai/grok-q": ll_entry("xai"),
        "xai/grok-q.20": ll_entry("xai"),
        "claude-k-5": ll_entry("anthropic", input_=2e-6, output=1e-5),
        "us-gov.anthropic.claude-k-5": ll_entry("bedrock_converse", input_=2.4e-6, output=1.2e-5),
    }
    rows = [
        row("grok-q", "xai", pattern=r"(?i)^(xai\/)?grok-q(-[\d-]+)?$"),
        row("grok-q.20", "xai", pattern=r"(?i)^(xai\/)?grok-q\.20$"),
        row("claude-k-5", "anthropic", input_=2e-6, output=1e-5),
    ]
    # The PR narrows grok-q, which stops pricing grok-q-20, and prices the GovCloud ID.
    own = r"(?i)^(us-gov\.anthropic\.)?claude-k-5$"
    pr_rows = [
        row("grok-q", "xai", pattern=r"(?i)^(xai\/)?grok-q(-\d{4})?$"),
        rows[1],
        row("claude-k-5", "anthropic", input_=2e-6, output=1e-5, pattern=own),
    ]
    code, posted, report = run(
        rows, litellm, md_catalog(), "--min-compared", "1", "--track", heads={1: pr_rows}
    )

    host = (
        "us-gov.anthropic.claude-k-5 priced at claude-k-5's rates, but the host lists "
        "input 2.40 (ours 2.00) and output 12.00 (ours 10.00)"
    )
    dash = "grok-q-20 no longer priced (was grok-q)"
    assert code == 0
    [pr] = report["pull_requests"]
    assert (pr["fixes"], pr["adds"]) == (
        ["us-gov.anthropic.claude-k-5 not priced by its row"],
        [host, dash],
    )
    progress = next(b for b in posted[0]["blocks"] if b.get("block_id") == "progress")
    assert f"• :warning: #1 would add: `{host}`, `{dash}`" in _block_text(progress)
