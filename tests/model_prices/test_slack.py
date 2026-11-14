"""Tests for the Slack message: what needs a fix in a few lines, within Block Kit
limits, with nothing from a catalog or an open PR posing as the message's own text."""

import json

from scripts.model_prices import slack
from scripts.model_prices.checks import PRICING_PAGES
from scripts.model_prices.slack import _fit, build_payload, failure_payload, post_to_slack
from scripts.model_prices.text import MAX_FLAGGED_LINES, format_report
from tests.model_prices.samples import (
    DATE,
    _block_text,
    _track_one_pr,
    _tracked_report,
    ll_entry,
    md_catalog,
    md_model,
    report_for,
    row,
)


def test_long_lists_are_cut_at_a_whole_line_with_a_count():
    lines = [f"• row-{n}: 3 Bedrock" for n in range(40)]
    text = _fit("*Heading*", lines, 200, "the JSON report")

    assert len(text) <= 200
    assert text.startswith("*Heading*\n• row-0: 3 Bedrock\n")
    kept = text.count("• row-")
    assert text.endswith(f"\n…and {40 - kept} more in the JSON report")
    # With no full list written, only the count.
    text = _fit("*Heading*", lines, 200)
    assert text.endswith(f"\n…and {40 - text.count('• row-')} more")
    assert _fit("*Heading*", lines[:2], 200) == "*Heading*\n" + "\n".join(lines[:2])


def test_slack_message_shows_what_needs_a_fix_in_a_few_lines():
    rows = [row("deepseek-d", "deepseek", input_=5e-7, output=1e-6)]
    litellm = {
        "deepseek/deepseek-d": ll_entry("deepseek", input_=1.32e-6, output=4e-6),
        "gpt-new": ll_entry("openai"),
        "gpt-new-latest": ll_entry("openai"),
        "gpt-realtime-new": ll_entry("openai", mode="realtime"),
        "<!channel>&co": ll_entry("openai"),
    }
    modelsdev = md_catalog(deepseek={"deepseek-d": md_model(input_=6.6e-7, output=4e-6)})
    payload = build_payload(report_for(rows, litellm, modelsdev), "https://pages.test/r")
    blocks = payload["blocks"]

    assert [b["type"] for b in blocks] == ["header", "section", "table", "section", "context"]
    assert payload["text"] == (
        f"Model pricing audit, {DATE}: 1 model with prices to check, 2 models not priced"
    )
    assert blocks[0]["text"] == {"type": "plain_text", "text": f"Model pricing audit · {DATE}"}
    # Without --track, nothing is known about open PRs.
    assert _block_text(blocks[1]) == (
        ":red_circle: *Needs a fix*\n• *1 model with prices to check*, USD per 1M tokens, "
        "ours vs. the catalogs:"
    )

    table = blocks[2]
    assert table["block_id"] == "prices"
    cells = [[cell["elements"][0]["elements"][0] for cell in r] for r in table["rows"]]
    assert [c["text"] for c in cells[0]] == ["Model", "Rate", "Ours", "Catalogs"]
    assert all(c["style"] == {"bold": True} for c in cells[0])
    assert cells[1][0] == {
        "type": "link",
        "url": PRICING_PAGES["deepseek"],
        "text": "deepseek-d",
    }
    assert [c["text"] for c in cells[1][1:]] == ["input", "0.50", "0.66-1.32"]
    assert [c["text"] for c in cells[2]] == [" ", "output", "1.00", "4.00"]

    # Counts only: aliases and realtime models are left to the full report.
    assert _block_text(blocks[3]) == "• *2 models not priced*: OpenAI 2"
    assert _block_text(blocks[4]) == (
        "<https://pages.test/r|Full report> · Checked 1 of 1 rows against LiteLLM and models.dev"
    )
    assert "<!channel>" not in json.dumps(payload)


def test_slack_message_stays_within_block_kit_limits():
    rows = [row(f"gpt-{n}", "openai", input_=5e-7) for n in range(30)]
    litellm = {f"gpt-{n}": ll_entry("openai") for n in range(30)}
    litellm.update({f"gpt-unpriced-model-{n:03d}": ll_entry("openai") for n in range(300)})
    litellm.update({f"gpt-unpriced-model-{n:03d}-latest": ll_entry("openai") for n in range(300)})
    blocks = build_payload(report_for(rows, litellm, md_catalog()))["blocks"]

    assert len(blocks) <= 50
    table = next(b for b in blocks if b["type"] == "table")
    assert len(table["rows"]) == MAX_FLAGGED_LINES + 1
    assert "…and 10 more rates" in _block_text(
        next(b for b in blocks if b.get("block_id") == "prices_more")
    )
    for block in blocks:
        limit = {"header": 150, "section": 3000, "context": 2000}.get(block["type"])
        if limit:
            assert len(_block_text(block)) <= limit, block["type"]


def test_tracked_prs_show_in_the_report_and_the_slack_table():
    report = _tracked_report()
    text = format_report(report)

    assert "1 model with prices to check (1 with an open PR)" in text
    assert "deepseek-d  input   0.50  → 1.00  #11, #12" in text
    assert "\n            output  1.00  → 2.00\n" in text
    assert "• *openai* (1): gpt-new (#12)" in text
    assert "• #12 would add: gpt-new input rate" in text
    assert "• #13: could not read it" in text
    assert "_Checked 2 of 2 rows against LiteLLM and models.dev and 3 open pricing PRs._" in text

    blocks = build_payload(report)["blocks"]
    assert [b.get("block_id") for b in blocks] == [None, "needs", "prices", "progress", "footer"]
    # The output rate has no PR, so it is the only row in the table.
    table = blocks[2]
    assert [[c["elements"][0]["elements"][0]["text"] for c in r] for r in table["rows"]] == [
        ["Model", "Rate", "Ours", "Catalogs"],
        ["deepseek-d", "output", "1.00", "2.00"],
    ]
    # Plain numbers: a GitHub link would unfurl into a preview. The report page links them.
    pr = "#{0}".format
    assert "github.test" not in json.dumps(blocks)
    assert _block_text(blocks[3]).split("\n") == [
        ":large_yellow_circle: *In progress (open PRs)*",
        f"• `deepseek-d` input $0.50 → $1.00: {pr(11)}, {pr(12)}",
        f"• `gpt-new` not priced: {pr(12)}",
        f"• :warning: {pr(13)}: could not read it",
        f"• :warning: {pr(12)} would add: `gpt-new input rate`",
    ]
    assert _block_text(blocks[4]) == (
        "Checked 2 of 2 rows against LiteLLM and models.dev and 3 open pricing PRs"
    )


def _progress(report):
    blocks = build_payload(report)["blocks"]
    return _block_text(next(b for b in blocks if b.get("block_id") == "progress")).split("\n")


def test_a_rate_our_row_leaves_out_shows_as_none_in_the_progress_line():
    litellm = {"gpt-a": ll_entry("openai", cache_read=5e-7)}
    fixed = [row("gpt-a", "openai", cache_read=5e-7)]
    report = _track_one_pr([row("gpt-a", "openai", cache_read=None)], litellm, fixed)

    assert "• `gpt-a` cache read none → $0.50: #7" in _progress(report)


def test_the_notification_says_when_every_fix_is_in_an_open_pr():
    litellm = {"gpt-a": ll_entry("openai", input_=2e-6)}
    report = _track_one_pr([row("gpt-a", "openai")], litellm, [row("gpt-a", "openai", input_=2e-6)])

    assert build_payload(report)["text"] == (
        f"Model pricing audit, {DATE}: nothing needs a fix that isn't in an open PR"
    )


def test_the_slack_message_claims_only_what_it_counted():
    # Aliases, snapshots, realtime and search models are left to the full report, so the
    # message can't say every model ID is priced, or everything found is in a PR.
    litellm = {
        "gpt-a": ll_entry("openai"),
        "gpt-a-latest": ll_entry("openai"),
        "gpt-realtime-a": ll_entry("openai", mode="realtime"),
    }
    report = report_for([row("gpt-a", "openai")], litellm, md_catalog())
    assert [item["model"] for item in report["missing"]] == ["gpt-a-latest", "gpt-realtime-a"]
    blocks = build_payload(report)["blocks"]
    assert _block_text(blocks[1]) == ":large_green_circle: *Prices match the catalogs*"

    flagged = [row("gpt-a", "openai", input_=5e-7)]
    payload = build_payload(_track_one_pr(flagged, litellm, [row("gpt-a", "openai")]))
    assert payload["text"] == (
        f"Model pricing audit, {DATE}: nothing needs a fix that isn't in an open PR"
    )


def test_a_prs_row_name_cannot_add_a_line_to_the_slack_message():
    rows = [row("gpt-a", "openai")]
    forged = row("x\n:large_green_circle: *All clear*", "openai", pattern=r"^nothing$")
    report = _track_one_pr(rows, {"gpt-a": ll_entry("openai")}, [*rows, forged])

    assert _progress(report) == [
        ":large_yellow_circle: *In progress (open PRs)*",
        "• :warning: #7 would add: `x :large_green_circle: *All clear*: matchPattern does not "
        "match the row's own modelName`",
    ]


def test_a_catalog_id_cannot_pose_as_the_slack_messages_own_text():
    # Slack renders no bold, emoji or links inside code, so names show as code, and a
    # backtick, which would end the code, shows as a look-alike.
    spoof = "gpt-z` :large_green_circle: *Prices match the catalogs*"
    shown = "`gpt-z\u02cb :large_green_circle: *Prices match the catalogs*`"
    rows = [
        row("gpt-a", "openai"),
        row("gpt-z1", "openai", pattern=r"(?i)^gpt-z"),
        row("gpt-z2", "openai", input_=2e-6, pattern=r"(?i)^gpt-z"),
    ]
    litellm = {"gpt-a": ll_entry("openai"), spoof: ll_entry("openai")}
    needs = build_payload(report_for(rows, litellm, md_catalog()))["blocks"][1]

    assert _block_text(needs).split("\n")[1] == (
        f"• *1 price file problem*, e.g. {shown} is matched by `gpt-z1` and `gpt-z2` at "
        "different prices; the worker uses `gpt-z1`"
    )
    pr_rows = [rows[0], row("gpt-z", "openai", pattern=r"(?i)^gpt-z")]
    report = _track_one_pr(rows[:1], litellm, pr_rows)
    assert _progress(report)[1] == f"• {shown} not priced: #7"


def test_a_failure_reason_is_escaped_in_the_notification_text_too():
    payload = failure_payload(DATE, "price file row <!channel> has no modelName")

    assert "<!channel>" not in json.dumps(payload)
    assert payload["text"].endswith(": price file row &lt;!channel&gt; has no modelName")


def test_slack_post_sends_the_payload_as_json(monkeypatch):
    sent = []

    class FakeResponse:
        def __enter__(self):
            return self

        def __exit__(self, *exc_info):
            return False

        def read(self):
            return b"ok"

    def fake_urlopen(request, timeout):
        sent.append(request)
        return FakeResponse()

    monkeypatch.setattr(slack, "urlopen", fake_urlopen)
    payload = {"text": "hello", "blocks": [{"type": "divider"}]}
    post_to_slack("https://hooks.example.test/T/B/x", payload)

    [request] = sent
    assert request.get_method() == "POST"
    assert request.get_header("Content-type") == "application/json"
    assert json.loads(request.data) == payload
