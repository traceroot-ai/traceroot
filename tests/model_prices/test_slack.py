"""Tests for the Slack message: the summary first, then a table with one row per model
and what open PRs fix, within Block Kit limits, with the full report as its only link and
nothing from a catalog or an open PR posing as the message's own text."""

import json
import re

from scripts.model_prices import slack
from scripts.model_prices.slack import (
    MAX_TABLE_MODELS,
    _fit,
    _rate,
    build_payload,
    failure_payload,
    post_to_slack,
)
from scripts.model_prices.text import _amount
from tests.model_prices.samples import (
    DATE,
    _block_text,
    _table_rows,
    _track_one_pr,
    _track_prs,
    ll_entry,
    md_catalog,
    report_for,
    row,
)

REPORT_URL = "https://pages.test/report"


def _busy_report():
    """A tracked run with every kind of finding the message shows. gpt-a's input and
    output rates are off, claude-c's cache read rate, and gpt-5-5, which the gpt-5 row
    prices, its input and output. claude-c's Bedrock ID has no price. Six models are not
    priced. Open PR #11 fixes deepseek-d's input rate, #12 prices gpt-new but at another
    rate, and #13 could not be read."""
    rows = [
        row("gpt-a", "openai", input_=5e-7, output=1e-6),
        row("claude-c", "anthropic", cache_read=2e-7),
        row("gpt-5", "openai", pattern=r"(?i)^(openai\/)?gpt-5(-[\d-]+)?$"),
        row("deepseek-d", "deepseek", input_=5e-7),
    ]
    litellm = {
        "gpt-a": ll_entry("openai", input_=1.25e-6, output=1e-5),
        "claude-c": ll_entry("anthropic", cache_read=1e-7),
        "us.anthropic.claude-c": ll_entry("bedrock_converse", cache_read=1e-7),
        "gpt-5": ll_entry("openai"),
        "gpt-5-5": ll_entry("openai", input_=5e-6, output=3e-5),
        "deepseek/deepseek-d": ll_entry("deepseek"),
        **{name: ll_entry("openai") for name in ("gpt-new", "gpt-x", "gpt-y")},
        **{f"xai/{name}": ll_entry("xai") for name in ("grok-x", "grok-y")},
        "zai/glm-z": ll_entry("zai"),
        "deepseek/deepseek-z": ll_entry("deepseek"),
    }
    fixed = [*rows[:3], row("deepseek-d", "deepseek")]
    heads = {11: fixed, 12: [*rows, row("gpt-new", "openai", input_=9e-6)], 13: "could not read it"}
    return _track_prs(rows, litellm, heads)


def _quiet_report():
    """A tracked run whose only finding, gpt-a's input rate, open PR #7 fixes."""
    litellm = {"gpt-a": ll_entry("openai", input_=2e-6)}
    return _track_one_pr([row("gpt-a", "openai")], litellm, [row("gpt-a", "openai", input_=2e-6)])


def _cut_report(models=MAX_TABLE_MODELS + 5):
    """An untracked run with the input rate of each of models models flagged."""
    rows = [row(f"gpt-{n}", "openai", input_=5e-7) for n in range(models)]
    litellm = {f"gpt-{n}": ll_entry("openai") for n in range(models)}
    return report_for(rows, litellm, md_catalog())


def _all_payloads():
    return [
        build_payload(_busy_report(), REPORT_URL, "the full report"),
        build_payload(_cut_report(), REPORT_URL, "the full report"),
        build_payload(_quiet_report(), REPORT_URL, "the full report"),
        failure_payload(DATE, "could not load the LiteLLM catalog (HTTPError)", REPORT_URL),
    ]


def _walk(node):
    """Every dict in a payload, depth first."""
    if isinstance(node, dict):
        yield node
        node = list(node.values())
    if isinstance(node, list):
        for child in node:
            yield from _walk(child)


def _ids(payload):
    return [block.get("block_id") for block in payload["blocks"]]


def _notes_at(blocks):
    """Where the job adds its provider_pages notes, as the Slack module says: after the
    last block whose block_id starts with "prices", or, with no table, before the divider."""
    ids = [block.get("block_id") or "" for block in blocks]
    prices = [index for index, block_id in enumerate(ids) if block_id.startswith("prices")]
    return prices[-1] + 1 if prices else [block["type"] for block in blocks].index("divider")


def test_slack_shows_whole_numbers_bare_and_other_rates_with_two_decimals_or_more():
    assert [_rate(rate) for rate in (1e-5, 1e-6, 2.5e-6, 1.4e-6, 1.25e-7, 3.625e-9)] == [
        "10",
        "1",
        "2.50",
        "1.40",
        "0.125",
        "0.003625",
    ]
    assert _rate(None) == "none"
    # The terminal and the report page keep two decimals on whole numbers.
    assert _amount(1e-5) == "10.00"


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


def test_a_busy_day_shows_the_summary_then_the_table_then_open_prs():
    payload = build_payload(_busy_report(), REPORT_URL, "the full report")
    blocks = payload["blocks"]

    assert [block["type"] for block in blocks] == [
        "header",
        "section",
        "context",
        "table",
        "divider",
        "section",
        "context",
        "context",
    ]
    assert _ids(payload) == [
        None,
        "needs",
        "prices_caption",
        "prices",
        None,
        "progress",
        "pr_warnings",
        "footer",
    ]
    assert payload["text"] == (
        f"Model pricing audit, {DATE}, no open PR: 3 models with prices to check, "
        "1 model ID with no price, 6 models not priced"
    )
    assert blocks[0]["text"]["text"] == f"Model pricing audit · {DATE}"
    assert _block_text(blocks[1]).split("\n") == [
        ":red_circle: *Needs a fix, no open PR*",
        "• *3 models with prices to check.* 1 of them falls under an older model's row, "
        "e.g. `gpt-5-5` under `gpt-5`.",
        "• *1 model ID with no price:* Bedrock IDs of 1 model we price, "
        "e.g. `us.anthropic.claude-c`",
        "• *6 models not priced:* OpenAI 2, xAI 2, DeepSeek 1 and 1 more",
    ]
    assert _block_text(blocks[2]) == (
        "USD per 1M tokens · input / output unless noted · cache rates in the full report"
    )
    # One row per model: input / output together, or the one rate flagged, named.
    assert _table_rows(blocks[3]) == [
        ["Model", "Ours", "Catalogs"],
        ["gpt-a", "0.50 / 1", "1.25 / 10"],
        ["claude-c cache read", "0.20", "0.10"],
        ["gpt-5-5", "1 / 2", "5 / 30"],
    ]
    assert _block_text(blocks[5]).split("\n") == [
        ":large_yellow_circle: *In open PRs*",
        "• `deepseek-d` input $0.50 → $1: #11",
        "• `gpt-new` (#12) not priced",
    ]
    assert _block_text(blocks[6]) == (
        ":warning: #12 would also add problems. #13 could not be checked. See the full report."
    )
    assert _block_text(blocks[7]) == (
        f"<{REPORT_URL}|Full report> · Checked 4 of 4 rows against LiteLLM and models.dev "
        "and 3 open pricing PRs"
    )


def test_model_names_in_the_table_are_code_and_numbers_are_raw_text():
    table = build_payload(_busy_report())["blocks"][3]

    assert table["column_settings"] == [
        {"is_wrapped": True},
        {"align": "right"},
        {"align": "right"},
    ]
    titles, gpt_a, claude_c, _ = table["rows"]
    assert all(cell["elements"][0]["elements"][0]["style"] == {"bold": True} for cell in titles)
    assert gpt_a[0]["elements"][0]["elements"] == [
        {"type": "text", "text": "gpt-a", "style": {"code": True}}
    ]
    assert claude_c[0]["elements"][0]["elements"][1] == {
        "type": "text",
        "text": " cache read",
        "style": {"italic": True},
    }
    assert gpt_a[1:] == [
        {"type": "raw_text", "text": "0.50 / 1"},
        {"type": "raw_text", "text": "1.25 / 10"},
    ]


def test_every_text_is_verbatim_and_every_section_expands():
    # Verbatim, Slack links no bare domain, such as models.dev in the footer.
    for payload in _all_payloads():
        nodes = list(_walk(payload["blocks"]))
        mrkdwn = [node for node in nodes if node.get("type") == "mrkdwn"]
        assert mrkdwn and all(node["verbatim"] is True for node in mrkdwn)
        sections = [node for node in nodes if node.get("type") == "section"]
        assert sections and all(node["expand"] is True for node in sections)


def test_the_full_report_is_the_only_link():
    # Slack previews every link, so pricing pages and PRs are plain text.
    report = _busy_report()
    assert all(item["pricing_page"] for item in report["flagged"])
    assert all(pr["url"] for pr in report["pull_requests"])
    for payload in _all_payloads():
        text = json.dumps(payload)
        assert re.findall(r"https?://[^\s|>\"]+", text) == [REPORT_URL]
        assert re.findall(r"<([^>|]*)[>|]", text) == [REPORT_URL]
        assert not [node for node in _walk(payload) if node.get("type") == "link"]
    assert "github.test" not in json.dumps(build_payload(report, REPORT_URL))


def test_the_table_shows_at_most_15_models_and_counts_the_rest():
    payload = build_payload(_cut_report(), REPORT_URL, "the full report")
    blocks = payload["blocks"]

    assert _ids(payload) == [
        None,
        "needs",
        "prices_caption",
        "prices",
        "prices_more",
        None,
        "footer",
    ]
    rows = _table_rows(blocks[3])
    assert len(rows) == 1 + MAX_TABLE_MODELS == 16
    assert rows[1] == ["gpt-0 input", "0.50", "1"]
    assert _block_text(blocks[4]) == "…and 5 more models in the full report"
    # Without a full report written, only the count.
    blocks = build_payload(_cut_report())["blocks"]
    assert _block_text(blocks[2]) == "USD per 1M tokens · input / output unless noted"
    assert _block_text(blocks[4]) == "…and 5 more models"


def test_provider_notes_have_a_place_before_the_divider_in_every_completed_run():
    # The job adds them after the table and its cut line, or, with no table, before
    # the divider; either way, right before the divider.
    litellm = {"gpt-a": ll_entry("openai"), "gpt-new": ll_entry("openai")}
    no_table = report_for([row("gpt-a", "openai")], litellm, md_catalog())
    reports = [_busy_report(), _cut_report(), _quiet_report(), no_table]
    for report in reports:
        blocks = build_payload(report, REPORT_URL, "the full report")["blocks"]
        assert blocks[_notes_at(blocks)]["type"] == "divider"
    assert _ids(build_payload(no_table)) == [None, "needs", None, "footer"]


def test_a_quiet_day_says_so_then_lists_what_open_prs_fix():
    payload = build_payload(_quiet_report(), REPORT_URL, "the full report")

    assert payload["text"] == (
        f"Model pricing audit, {DATE}: nothing needs a fix that isn't in an open PR"
    )
    assert _ids(payload) == [None, "needs", None, "progress", "footer"]
    blocks = payload["blocks"]
    assert _block_text(blocks[1]) == (
        ":large_green_circle: *Nothing needs a fix that isn't in an open PR*"
    )
    assert _block_text(blocks[3]).split("\n") == [
        ":large_yellow_circle: *In open PRs*",
        "• `gpt-a` input $1 → $2: #7",
    ]
    assert _block_text(blocks[4]).startswith(f"<{REPORT_URL}|Full report> · Checked 1 of 1 rows")


def test_a_failed_run_says_why_and_that_it_is_not_an_all_clear():
    payload = failure_payload(DATE, "could not load the LiteLLM catalog (HTTPError)", REPORT_URL)

    assert payload["text"] == (
        f"Model pricing audit FAILED, {DATE}: could not load the LiteLLM catalog (HTTPError). "
        "Not an all-clear."
    )
    assert _ids(payload) == [None, "failed", "footer"]
    blocks = payload["blocks"]
    assert blocks[0]["text"]["text"] == f"Model pricing audit failed · {DATE}"
    assert _block_text(blocks[1]) == (
        ":x: *No report today.* The check stopped: "
        "`could not load the LiteLLM catalog (HTTPError)`\n"
        "Nothing was compared, so this is not an all-clear."
    )
    assert _block_text(blocks[2]) == (
        f"The <{REPORT_URL}|full report> still shows the last completed run."
    )
    # With no page to point to, no footer.
    assert _ids(failure_payload(DATE, "boom")) == [None, "failed"]


def test_a_failure_reason_is_escaped_in_the_notification_text_too():
    payload = failure_payload(DATE, "price file row <!channel> has `x` and no modelName")

    assert "<!channel>" not in json.dumps(payload)
    assert payload["text"].endswith(
        ": price file row &lt;!channel&gt; has `x` and no modelName. Not an all-clear."
    )
    assert "`price file row &lt;!channel&gt; has \u02cbx\u02cb and no modelName`" in (
        _block_text(payload["blocks"][1])
    )


def test_slack_message_stays_within_block_kit_limits():
    rows = [row(f"gpt-{n}", "openai", input_=5e-7) for n in range(30)]
    litellm = {f"gpt-{n}": ll_entry("openai") for n in range(30)}
    litellm.update({f"gpt-unpriced-model-{n:03d}": ll_entry("openai") for n in range(300)})
    litellm.update({f"gpt-unpriced-model-{n:03d}-latest": ll_entry("openai") for n in range(300)})
    reports = [report_for(rows, litellm, md_catalog()), _busy_report()]
    payloads = [build_payload(report, REPORT_URL, "the full report") for report in reports]
    payloads.append(failure_payload(DATE, "x" * 5000, REPORT_URL))

    for payload in payloads:
        blocks = payload["blocks"]
        assert len(blocks) <= 50
        tables = [block for block in blocks if block["type"] == "table"]
        assert len(tables) <= 1
        assert all(len(table["rows"]) <= 1 + MAX_TABLE_MODELS for table in tables)
        for block in blocks:
            limit = {"header": 150, "section": 3000, "context": 2000}.get(block["type"])
            if limit:
                assert len(_block_text(block)) <= limit, block["type"]


def _progress(report):
    blocks = build_payload(report)["blocks"]
    return _block_text(next(b for b in blocks if b.get("block_id") == "progress")).split("\n")


def test_a_rate_our_row_leaves_out_shows_as_none_in_the_progress_line():
    litellm = {"gpt-a": ll_entry("openai", cache_read=5e-7)}
    fixed = [row("gpt-a", "openai", cache_read=5e-7)]
    report = _track_one_pr([row("gpt-a", "openai", cache_read=None)], litellm, fixed)

    assert "• `gpt-a` cache read none → $0.50: #7" in _progress(report)


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


def test_a_prs_row_name_never_reaches_the_slack_message():
    # Open PRs that would add problems are named by number alone.
    rows = [row("gpt-a", "openai")]
    forged = row("x\n:large_green_circle: *All clear*", "openai", pattern=r"^nothing$")
    report = _track_one_pr(rows, {"gpt-a": ll_entry("openai")}, [*rows, forged])
    payload = build_payload(report)

    assert _ids(payload) == [None, "needs", None, "pr_warnings", "footer"]
    assert _block_text(payload["blocks"][3]) == ":warning: #7 would also add problems."
    assert "All clear" not in json.dumps(payload)


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
    assert _progress(report)[1] == f"• {shown} (#7) not priced"
    # In the table, a name is rich text, which Slack never reads as mrkdwn.
    rows = [row("gpt-z", "openai", input_=5e-7, pattern=r"(?i)^gpt-z")]
    litellm = {"gpt-z": ll_entry("openai", input_=5e-7), spoof: ll_entry("openai")}
    flagged = report_for(rows, litellm, md_catalog())
    table = next(b for b in build_payload(flagged)["blocks"] if b["type"] == "table")
    assert table["rows"][1][0]["elements"][0]["elements"][0] == {
        "type": "text",
        "text": spoof,
        "style": {"code": True},
    }


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
