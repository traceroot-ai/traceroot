"""Tests for the terminal report."""

from scripts.model_prices.checks import PRICING_PAGES
from scripts.model_prices.text import _escape, format_report
from tests.model_prices.samples import DATE, ll_entry, md_catalog, md_model, report_for, row


def test_every_missing_model_is_in_the_message():
    rows = [row("gpt-a", "openai")]
    litellm = {"gpt-a": ll_entry("openai")}
    litellm.update({f"gpt-new-{n}": ll_entry("openai") for n in range(30)})
    litellm.update({f"xai/grok-new-{n}": ll_entry("xai") for n in range(12)})
    report = report_for(rows, litellm, md_catalog())
    text = format_report(report)

    assert len(report["missing"]) == 42
    for item in report["missing"]:
        assert item["model"] in text
    assert "• *openai* (30): gpt-new-0, gpt-new-1," in text
    assert "• *xai* (12): grok-new-0," in text
    assert "more in the JSON report" not in text


def test_catalog_model_ids_are_escaped_for_slack():
    rows = [row("deepseek-d", "deepseek", input_=5e-7)]
    litellm = {
        "deepseek/deepseek-d": ll_entry("deepseek", input_=1e-6),
        "<!channel>&co": ll_entry("openai"),
    }
    text = format_report(report_for(rows, litellm, md_catalog()))

    assert "&lt;!channel&gt;&amp;co" in text
    assert "<!channel>" not in text
    # Our own link markup is left intact.
    assert f"<{PRICING_PAGES['deepseek']}|deepseek>" in text


def test_flagged_message_lists_every_rate_and_the_pricing_page():
    rows = [row("deepseek-d", "deepseek", input_=5e-7)]
    litellm = {"deepseek/deepseek-d": ll_entry("deepseek", input_=1e-6)}
    modelsdev = md_catalog(deepseek={"deepseek-d": md_model(input_=1e-6)})
    text = format_report(report_for(rows, litellm, modelsdev))

    assert text.startswith(f"*Model pricing audit, {DATE}*: 1 model with prices to check")
    assert "deepseek-d  input  0.50  → 1.00" in text
    assert f"Pricing pages: <{PRICING_PAGES['deepseek']}|deepseek>" in text


def test_price_table_groups_rates_by_model_and_shows_catalog_ranges():
    rows = [row("deepseek-d", "deepseek", input_=5e-7, output=1e-6, cache_read=3.625e-9)]
    litellm = {
        "deepseek/deepseek-d": ll_entry("deepseek", input_=1.32e-6, output=4e-6, cache_read=4.4e-8)
    }
    modelsdev = md_catalog(
        deepseek={"deepseek-d": md_model(input_=6.6e-7, output=4e-6, cache_read=2.2e-8)}
    )
    text = format_report(report_for(rows, litellm, modelsdev))

    assert "```\ndeepseek-d  input       0.50      → 0.66-1.32\n" in text
    assert "\n            output      1.00      → 4.00\n" in text
    assert "\n            cache read  0.003625  → 0.022-0.044\n```" in text
    assert text.index("*Prices to check*") < text.index("_Compared 1 of 1 rows")


def test_escape_drops_terminal_control_characters():
    # Row names come from open PRs, and the terminal prints the same text as Slack.
    assert _escape("gpt-\x1b]52;c;eA==\x07a\nb") == "gpt- ]52;c;eA== a b"


def test_baseline_shows_first_in_the_text_report():
    report = report_for([row("gpt-a", "openai")], {"gpt-a": ll_entry("openai")}, md_catalog())
    report["baseline"] = {"fixes": ["gpt-z input rate"], "adds": []}
    text = format_report(report)

    assert (
        "\n\n*Compared with the baseline, this file fixes* (1)\n• gpt-z input rate"
        "\n\n*Compared with the baseline, this file adds* (0)\n• nothing\n"
    ) in text
