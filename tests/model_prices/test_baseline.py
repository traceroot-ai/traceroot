"""Tests for --baseline: what an edit to the price file fixes and adds, compared with a
report saved before it, and the same adds that --track lists for an open PR."""

import json

import pytest

from tests.model_prices.samples import (
    DATE,
    _block_text,
    compare,
    ll_entry,
    md_catalog,
    report_for,
    row,
    runner,
)


@pytest.fixture
def run(tmp_path, monkeypatch):
    """Run main() against sample data, as runner describes."""
    return runner(tmp_path, monkeypatch)


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


@pytest.mark.parametrize(
    ("model", "extra"),
    [
        ("gpt-q-audio", {}),
        ("gpt-q", {"mode": "audio_speech"}),
        ("gpt-q-old", {"deprecation_date": "2026-01-01"}),
    ],
    ids=["ignored", "not-text", "retired"],
)
def test_deleting_a_flagged_row_is_added_not_fixed(model, extra):
    # The missing models leave these out, so nothing else would show the row is gone.
    litellm = {"gpt-a": ll_entry("openai"), model: ll_entry("openai", input_=4e-6, **extra)}
    before = [row("gpt-a", "openai"), row(model, "openai")]

    assert compare(before, before[:1], litellm, md_catalog()) == {
        "fixes": [],
        "adds": [f"{model} row removed"],
    }


def test_deleting_a_row_with_no_finding_adds_only_what_its_absence_shows():
    # gpt-b shows as not priced. The missing models leave the audio model out, and its
    # row had nothing to fix, so its deletion lists nothing.
    litellm = {
        "gpt-a": ll_entry("openai"),
        "gpt-b": ll_entry("openai"),
        "gpt-q-audio": ll_entry("openai"),
    }
    before = [row("gpt-a", "openai"), row("gpt-b", "openai"), row("gpt-q-audio", "openai")]

    assert compare(before, before[:1], litellm, md_catalog()) == {
        "fixes": [],
        "adds": ["gpt-b not priced"],
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


@pytest.mark.parametrize("key", ["dash_spellings", "host_rates", "compared_rows", "date"])
def test_a_baseline_from_another_version_fails_the_run(run, tmp_path, key):
    # Without its dash spellings, host rates or compared rows, an edit that stops pricing
    # a dash spelling, prices a host ID at the wrong rate, or deletes a flagged row,
    # would pass unseen.
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
    # Each add, such as a rate a new row leaves out, is checked on its own, so one
    # model's rates are not merged into one line.
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
