"""Tests for --baseline: what an edit to the price file fixes and adds, compared with a
report saved before it, and the same adds that --track lists for an open PR."""

import json
from urllib.error import URLError

import pytest

from tests.model_prices.samples import (
    DATE,
    _block_text,
    _track_one_pr,
    baseline_for,
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


def test_a_row_named_after_a_1m_id_prices_it_right_only_at_its_models_rates():
    # No catalog lists [1m] IDs, so nothing else checks a row named one.
    litellm = {"claude-l": ll_entry("anthropic", max_input_tokens=1_000_000)}
    before = [row("claude-l", "anthropic")]
    pattern = r"(?i)^claude-l\[1m\]$"
    free = row("claude-l[1m]", "anthropic", input_=0, output=0, cache_read=0, pattern=pattern)
    same = row("claude-l[1m]", "anthropic", pattern=pattern)

    assert compare(before, [*before, free], litellm, md_catalog()) == {
        "fixes": [],
        "adds": ["claude-l[1m] priced as claude-l[1m]"],
    }
    assert compare(before, [*before, same], litellm, md_catalog()) == {
        "fixes": ["claude-l[1m] not priced by its row"],
        "adds": [],
    }
    [pr] = _track_one_pr(before, litellm, [*before, free])["pull_requests"]
    assert (pr["fixes"], pr["adds"]) == ([], ["claude-l[1m] priced as claude-l[1m]"])


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
        "adds": ["deepseek-d no longer compared with the catalogs", "deepseek-d provider changed"],
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


def test_deleting_a_row_with_no_finding_is_added():
    # gpt-b also shows as not priced. The missing models leave the audio model out, and
    # its row had nothing to fix, so only the baseline report's rows show it is gone.
    litellm = {
        "gpt-a": ll_entry("openai"),
        "gpt-b": ll_entry("openai"),
        "gpt-q-audio": ll_entry("openai"),
    }
    before = [row("gpt-a", "openai"), row("gpt-b", "openai"), row("gpt-q-audio", "openai")]

    assert compare(before, before[:1], litellm, md_catalog()) == {
        "fixes": [],
        "adds": ["gpt-b not priced", "gpt-b row removed", "gpt-q-audio row removed"],
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
    baseline_for(run, baseline, before, litellm, md_catalog())
    args = ("--min-compared", "1", "--baseline", str(baseline))

    fixed = [row("gpt-a", "openai", input_=2e-6), row("gpt-b", "openai")]
    code, _, report = run(fixed, litellm, md_catalog(), *args)
    assert code == 0
    assert report["baseline"] == {"fixes": ["gpt-a input rate (ours 1.00)"], "adds": []}

    broke = [row("gpt-a", "openai"), row("gpt-b", "openai", input_=9e-6)]
    code, _, report = run(broke, litellm, md_catalog(), *args)
    assert code == 3
    assert report["baseline"]["adds"] == ["gpt-b input rate (ours 9.00)"]

    baseline.write_text(json.dumps({"date": DATE, "status": "failed", "error": "x"}))
    code, posted, _ = run(fixed, litellm, md_catalog(), *args)
    assert code == 1
    assert "the baseline report is not from a completed run" in posted[-1]["text"]


# gpt-b's input rate is flagged, no catalog lists gpt-old, and gpt-big's input rate is a
# per-million price. claude-f's pattern prices claude-f-2 at claude-f's rates and misses
# the Bedrock ID us.anthropic.claude-f.
ROW_EDIT_LITELLM = {
    "gpt-a": ll_entry("openai"),
    "gpt-b": ll_entry("openai", input_=2e-6),
    "claude-f": ll_entry("anthropic"),
    "claude-f-2": ll_entry("anthropic", input_=8e-6),
    "us.anthropic.claude-f": ll_entry("bedrock"),
}
ROW_EDIT_BEFORE = [
    row("gpt-a", "openai"),
    row("gpt-b", "openai"),
    row("gpt-old", "openai"),
    row("gpt-big", "openai", input_=2e-3),
    row("claude-f", "anthropic", pattern=r"(?i)^claude-f(-[\d-]+)?$"),
]


def _edited(edit):
    """ROW_EDIT_BEFORE with each row edit names replaced by its value, or removed when
    the value is None, and the rows it names that are not there added."""
    names = {r["modelName"] for r in ROW_EDIT_BEFORE}
    after = [edit.get(r["modelName"], r) for r in ROW_EDIT_BEFORE]
    return [r for r in after if r] + [r for name, r in edit.items() if name not in names]


def _run_row_edit(run, tmp_path, edit):
    """Run main() on ROW_EDIT_BEFORE after edit, with --baseline set to the report on
    ROW_EDIT_BEFORE."""
    baseline = tmp_path / "before.json"
    baseline_for(run, baseline, ROW_EDIT_BEFORE, ROW_EDIT_LITELLM, md_catalog())
    return run(
        _edited(edit),
        ROW_EDIT_LITELLM,
        md_catalog(),
        "--min-compared",
        "1",
        "--baseline",
        str(baseline),
    )


@pytest.mark.parametrize(
    ("edit", "fixes", "add"),
    [
        (
            {"gpt-old": row("gpt-old", "openai", input_=1e-4)},
            [],
            "gpt-old input rate changed with no finding to fix (ours 1.00 → 100.00)",
        ),
        (
            {"gpt-a": row("gpt-a", "openai", input_=1.029e-6)},
            [],
            "gpt-a input rate changed with no finding to fix (ours 1.00 → 1.029)",
        ),
        (
            {"gpt-b": row("gpt-b", "openai", input_=2e-6, output=2.05e-6)},
            ["gpt-b input rate (ours 1.00)"],
            "gpt-b output rate changed with no finding to fix (ours 2.00 → 2.05)",
        ),
        ({"gpt-old": None}, [], "gpt-old row removed"),
        (
            {"gpt-old": {**row("gpt-old", "openai"), "provider": "xai"}},
            [],
            "gpt-old provider changed",
        ),
        (
            {"gpt-a": row("gpt-a", "openai", pattern=r"(?i)^(openai\/)?gpt-a(-\d{4})?$")},
            [],
            "gpt-a matchPattern changed with no finding to fix",
        ),
    ],
    ids=[
        "uncompared-rate",
        "inside-tolerance",
        "fix-and-another-field",
        "row-removed",
        "provider",
        "pattern-moves-nothing",
    ],
)
def test_baseline_adds_a_row_change_no_finding_explains(run, tmp_path, edit, fixes, add):
    # No catalog compares a quarter of the rows, and a rate changed inside the tolerance
    # shows no flag, so only the baseline report's rows show these. --track judges an
    # open PR by its findings alone, so it lists none of them.
    code, _, report = _run_row_edit(run, tmp_path, edit)

    assert code == 3
    assert report["baseline"] == {"fixes": fixes, "adds": [add]}
    [pr] = _track_one_pr(ROW_EDIT_BEFORE, ROW_EDIT_LITELLM, _edited(edit))["pull_requests"]
    assert pr["adds"] == []


@pytest.mark.parametrize(
    ("edit", "fixes"),
    [
        ({"gpt-b": row("gpt-b", "openai", input_=2e-6)}, ["gpt-b input rate (ours 1.00)"]),
        (
            {
                "claude-f": row(
                    "claude-f", "anthropic", pattern=r"(?i)^(us\.anthropic\.)?claude-f(-[\d-]+)?$"
                )
            },
            ["us.anthropic.claude-f not priced by its row"],
        ),
        (
            {
                "claude-f": row("claude-f", "anthropic", pattern=r"(?i)^claude-f(-\d{8})?$"),
                "claude-f-2": row("claude-f-2", "anthropic", input_=8e-6),
            },
            ["claude-f-2 input rate (ours 1.00)"],
        ),
        (
            {
                "claude-f": row("claude-f", "anthropic", pattern=r"(?i)^claude-f(-2)?$"),
                "claude-f-3": row("claude-f-3", "anthropic"),
            },
            [],
        ),
        (
            {"gpt-big": row("gpt-big", "openai", input_=2e-6)},
            ["gpt-big: input rate is outside $0-$1,000 per 1M tokens"],
        ),
    ],
    ids=[
        "flagged-rate",
        "host-prefix",
        "new-row-and-narrowed-row",
        "row-split-off",
        "row-problem",
    ],
)
def test_baseline_passes_a_row_change_a_finding_explains(run, tmp_path, edit, fixes):
    code, _, report = _run_row_edit(run, tmp_path, edit)

    assert code == 0
    assert report["baseline"] == {"fixes": fixes, "adds": []}


@pytest.mark.parametrize(
    "key", ["dash_spellings", "host_rates", "compared_rows", "date", "catalogs", "rows"]
)
def test_a_baseline_from_another_version_fails_the_run(run, tmp_path, key):
    # Without its dash spellings, host rates, compared rows or rows, an edit that stops
    # pricing a dash spelling, prices a host ID at the wrong rate, deletes a flagged row,
    # or changes a row no finding shows, would pass unseen.
    litellm = {"gpt-a": ll_entry("openai")}
    rows = [row("gpt-a", "openai")]
    saved = {**report_for(rows, litellm, md_catalog()), "catalogs": {}}
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
    baseline_for(run, baseline, rows, litellm, md_catalog())

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
    baseline_for(run, baseline, before, litellm, md_catalog())
    after = [*before, row("claude-x", "anthropic", cache_read=8e-7)]

    code, _, report = run(
        after, litellm, md_catalog(), "--min-compared", "1", "--baseline", str(baseline)
    )

    adds = ["claude-x cache read rate (ours 0.80)", "claude-x cache write 1h rate (ours none)"]
    assert code == 3
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
    # Slack names the PR; the full report lists what it would add.
    warning = next(b for b in posted[0]["blocks"] if b.get("block_id") == "pr_warnings")
    assert "#1 would also add problems" in _block_text(warning)


def test_baseline_from_other_catalogs_fails_the_run(run, tmp_path):
    # A catalog that moved between the two runs would be credited as a fix with no edit.
    litellm = {"gpt-a": ll_entry("openai", input_=2e-6)}
    rows = [row("gpt-a", "openai")]
    baseline = tmp_path / "before.json"
    baseline_for(run, baseline, rows, litellm, md_catalog())
    args = ("--min-compared", "1", "--baseline", str(baseline))
    message = (
        "the catalogs or reviewed rates differ from the baseline report's: pass the same "
        "saved --litellm, --modelsdev and --reviewed files to both runs"
    )

    for moved, other in (
        (({"gpt-a": ll_entry("openai")}, md_catalog())),
        ((litellm, md_catalog(openai={"gpt-x": {}}))),
    ):
        code, posted, report = run(rows, moved, other, *args)
        assert code == 1
        assert report["status"] == "failed"
        assert message in posted[-1]["text"]


def test_baseline_from_another_reviewed_list_fails_the_run(run, tmp_path):
    # A rate reviewed between the two runs stops being flagged, which reads as a fix.
    litellm = {"gpt-a": ll_entry("openai", input_=2e-6)}
    rows = [row("gpt-a", "openai")]
    baseline = tmp_path / "before.json"
    baseline_for(run, baseline, rows, litellm, md_catalog())
    reviewed = tmp_path / "reviewed.json"
    entry = {
        "model": "gpt-a",
        "field": "input",
        "ours": 1e-6,
        "litellm": 2e-6,
        "modelsdev": None,
        "reason": "checked",
        "pr": None,
    }
    reviewed.write_text(json.dumps([entry]))

    code, posted, _ = run(
        rows,
        litellm,
        md_catalog(),
        "--min-compared",
        "1",
        "--baseline",
        str(baseline),
        "--reviewed",
        str(reviewed),
    )

    assert code == 1
    assert "the catalogs or reviewed rates differ from the baseline report's" in posted[-1]["text"]


def test_an_add_exits_3_even_when_github_cannot_be_read(run, tmp_path):
    litellm = {"gpt-a": ll_entry("openai")}
    baseline = tmp_path / "before.json"
    baseline_for(run, baseline, [row("gpt-a", "openai")], litellm, md_catalog())

    def offline(url):
        raise URLError("offline")

    code, _, report = run(
        [row("gpt-a", "openai", input_=9e-6)],
        litellm,
        md_catalog(),
        "--min-compared",
        "1",
        "--baseline",
        str(baseline),
        "--track",
        github=offline,
    )

    assert code == 3
    assert report["tracking"] == "GitHub could not be read (URLError)"
