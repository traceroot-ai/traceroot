"""Tests for the comparisons: a rate is flagged only when every catalog that lists the
model disagrees, and catalog models, model IDs and price file problems that production
would price wrong are listed."""

import pytest

from scripts.model_prices.catalogs import CheckError
from scripts.model_prices.checks import JS_INCOMPATIBLE, PRICING_PAGES, differs, lookup
from scripts.model_prices.page import build_html
from scripts.model_prices.slack import build_payload
from scripts.model_prices.text import format_report
from tests.model_prices.samples import (
    DATE,
    _block_text,
    ll_entry,
    md_catalog,
    md_model,
    report_for,
    row,
)


def test_tolerance_boundary():
    assert not differs(1e-6, 1.029e-6)
    assert differs(1e-6, 1.031e-6)
    assert not differs(0.0, 0.0)


def test_flags_only_when_every_catalog_disagrees():
    rows = [row("gpt-a", "openai", input_=1e-6)]
    litellm = {"gpt-a": ll_entry("openai", input_=2e-6)}

    agreeing = md_catalog(openai={"gpt-a": md_model(input_=1e-6)})
    assert report_for(rows, litellm, agreeing)["flagged"] == []

    disagreeing = md_catalog(openai={"gpt-a": md_model(input_=2e-6)})
    [flag] = report_for(rows, litellm, disagreeing)["flagged"]
    assert flag["model"] == "gpt-a"
    assert flag["field"] == "input"
    assert flag["ours"] == 1e-6
    assert flag["litellm"] == pytest.approx(2e-6)
    assert flag["modelsdev"] == pytest.approx(2e-6)
    assert flag["pricing_page"] == PRICING_PAGES["openai"]


def test_one_catalog_is_enough_when_the_other_lacks_the_model():
    rows = [row("gemini-c", "google", output=2e-6)]
    # LiteLLM prefixes Gemini keys; the prefix is stripped to get the model ID.
    litellm = {"gemini/gemini-c": ll_entry("gemini", output=4e-6)}
    report = report_for(rows, litellm, md_catalog())

    assert report["compared"] == 1
    assert [(f["model"], f["field"], f["modelsdev"]) for f in report["flagged"]] == [
        ("gemini-c", "output", None)
    ]


def test_null_and_missing_rates_are_skipped():
    rows = [row("claude-b", "anthropic", cache_read=1e-7)]
    litellm = {"claude-b": ll_entry("anthropic", cache_read=None)}
    modelsdev = md_catalog(anthropic={"claude-b": md_model(cache_read=None)})
    report = report_for(rows, litellm, modelsdev)

    assert report["compared"] == 1
    assert report["flagged"] == []


def test_our_missing_or_null_rate_is_flagged_when_the_catalogs_charge_for_it():
    # Production bills a missing or null cache rate at nothing.
    rows = [
        row("gpt-a", "openai", cache_read=None),
        row("gpt-b", "openai", cache_read=None),
        row("kimi-n", "moonshot"),  # cacheWrite is null and cacheWrite1h left out
    ]
    litellm = {
        "gpt-a": ll_entry("openai", cache_read=5e-7),
        "gpt-b": ll_entry("openai", cache_read=0.0),  # no charge, so nothing is lost
        "moonshot/kimi-n": ll_entry(
            "moonshot",
            cache_creation_input_token_cost=3e-6,
            cache_creation_input_token_cost_above_1hr=6e-6,
        ),
    }
    modelsdev = md_catalog(moonshotai={"kimi-n": md_model(cost={"cache_write": 3.0})})
    report = report_for(rows, litellm, modelsdev)

    assert [(f["model"], f["field"], f["ours"]) for f in report["flagged"]] == [
        ("gpt-a", "cacheRead", None),
        ("kimi-n", "cacheWrite", None),
        ("kimi-n", "cacheWrite1h", None),
    ]
    assert "gpt-a   cache read      none  → 0.50" in format_report(report)


def test_lookup_matches_exact_name_before_patterns():
    broad = row("gpt-x", "openai", pattern=r"(?i)^gpt-.*$")
    exact = row("gpt-b", "openai")
    broken = row("gpt-c", "openai", pattern="(")
    rows = [broken, broad, exact]

    assert lookup(rows, "gpt-b") is exact
    assert lookup(rows, "gpt-anything") is broad
    assert lookup(rows, "claude-z") is None


def test_missing_models_follow_production_lookup_and_skip_non_text():
    rows = [
        row("claude-b", "anthropic", pattern=r"(?i)^(anthropic\/)?claude-b(-[\d-]+)?$"),
        row("gpt-a", "openai"),
    ]
    litellm = {
        "gpt-a": ll_entry("openai"),
        "claude-b-20260101": ll_entry("anthropic"),  # matched by the pattern
        "claude-new": ll_entry("anthropic"),
        "gemini/gemini-live": ll_entry("gemini", mode="realtime"),
        "text-embedding-z": ll_entry("openai", mode="embedding"),
        "gpt-voice": ll_entry("openai", mode="audio_speech"),
        "ft:gpt-a": ll_entry("openai"),
    }
    modelsdev = md_catalog(
        openai={
            "gpt-a": md_model(),
            "gpt-new": md_model(),
            "gpt-picture": md_model(outputs=("image",)),
        },
        anthropic={"claude-new": md_model()},
    )
    report = report_for(rows, litellm, modelsdev)

    assert [(m["provider"], m["model"], m["in"]) for m in report["missing"]] == [
        ("anthropic", "claude-new", ["litellm", "modelsdev"]),
        ("google", "gemini-live", ["litellm"]),
        ("openai", "gpt-new", ["modelsdev"]),
    ]


def test_models_priced_through_another_rows_pattern_are_compared_with_that_row():
    # The older row's pattern, meant for dated snapshots, also matches newer versions.
    rows = [
        row(
            "claude-f",
            "anthropic",
            input_=1e-5,
            cache_read=1e-6,
            pattern=r"(?i)^claude-f(-[\d-]+)?$",
        )
    ]
    litellm = {
        "claude-f": ll_entry("anthropic", input_=1e-5, cache_read=1e-6),
        "claude-f-20260101": ll_entry("anthropic", input_=1e-5, cache_read=1e-6),
        "claude-f-2": ll_entry("anthropic", input_=8e-6, cache_read=2e-7),
        "claude-f-1": ll_entry("anthropic", cache_read=2.5e-7, deprecation_date="2026-01-31"),
    }
    modelsdev = md_catalog(anthropic={"claude-f-2": md_model(input_=8e-6, cache_read=2e-7)})
    report = report_for(rows, litellm, modelsdev)

    # The dated snapshot costs the same, and the retired version is skipped.
    assert report["missing"] == []
    assert [(f["model"], f["field"], f["ours"], f["priced_as"]) for f in report["flagged"]] == [
        ("claude-f-2", "input", 1e-5, "claude-f"),
        ("claude-f-2", "cacheRead", 1e-6, "claude-f"),
    ]
    assert report["flagged"][0]["pricing_page"] == PRICING_PAGES["anthropic"]
    assert "claude-f-2 (priced as claude-f)  input" in format_report(report)
    blocks = build_payload(report)["blocks"]
    assert _block_text(blocks[1]).endswith(
        "• *1 model with prices to check.* 1 of them falls under an older model's row, "
        "e.g. `claude-f-2` under `claude-f`."
    )
    table = next(b for b in blocks if b["type"] == "table")
    assert table["rows"][1][0]["elements"][0]["elements"] == [
        {"type": "text", "text": "claude-f-2", "style": {"code": True}},
        {"type": "text", "text": " input", "style": {"italic": True}},
    ]


def test_a_dotted_versions_dash_spelling_is_compared_with_the_row_that_prices_it():
    # Gateways send gpt-g-5 for gpt-g.5, and the gpt-g row's date group also matches it.
    rows = [
        row("gpt-g", "openai", pattern=r"(?i)^(openai\/)?gpt-g(-[\d-]+)?$"),
        row("gpt-g.5", "openai", input_=5e-6, pattern=r"(?i)^(openai\/)?gpt-g\.5$"),
        # This row takes both spellings, but not with the provider in front.
        row("gpt-m", "openai", pattern=r"(?i)^(openai\/)?gpt-m(-[\d-]+)?$"),
        row("gpt-m-2", "openai", input_=4e-6, pattern=r"(?i)^gpt-m[.-]2$"),
    ]
    litellm = {
        "gpt-g.1": ll_entry("openai"),  # gpt-g-1 is priced as gpt-g, at the same rates
        "gpt-g.5": ll_entry("openai", input_=5e-6),
        "gpt-m.2": ll_entry("openai", input_=4e-6),
    }
    report = report_for(rows, litellm, md_catalog())

    assert [(f["model"], f["field"], f["ours"], f["priced_as"]) for f in report["flagged"]] == [
        ("gpt-g-5", "input", 1e-6, "gpt-g"),
        ("openai/gpt-m-2", "input", 1e-6, "gpt-m"),
    ]
    assert "gpt-g-5 (priced as gpt-g)         input  1.00  → 5.00" in format_report(report)


def test_a_catalog_id_that_differs_only_in_case_is_compared_with_the_row_that_prices_it():
    # The exact-name match is case-sensitive, so GPT-U is priced through gpt-u's pattern.
    rows = [row("gpt-u", "openai")]
    litellm = {"GPT-U": ll_entry("openai", input_=2e-6)}
    report = report_for(rows, litellm, md_catalog(), min_compared=0)

    assert [(f["model"], f["field"], f["priced_as"]) for f in report["flagged"]] == [
        ("GPT-U", "input", "gpt-u")
    ]


def test_cache_write_rates_are_compared():
    rows = [row("claude-w", "anthropic")]
    rows[0]["prices"].update(cacheWrite=1.25e-6, cacheWrite1h=2e-6)
    no_1h = row("claude-v", "anthropic")  # no cacheWrite1h key at all
    litellm = {
        "claude-w": ll_entry(
            "anthropic",
            cache_creation_input_token_cost=2.5e-6,
            cache_creation_input_token_cost_above_1hr=2e-6,
        ),
        "claude-v": ll_entry("anthropic"),
    }
    modelsdev = md_catalog(anthropic={"claude-w": md_model(cost={"cache_write": 2.5})})
    report = report_for([*rows, no_1h], litellm, modelsdev)

    # cacheWrite1h is optional in the price file, and only LiteLLM has a 1-hour rate.
    assert [(f["model"], f["field"], f["ours"]) for f in report["flagged"]] == [
        ("claude-w", "cacheWrite", 1.25e-6)
    ]
    assert "claude-w  cache write  1.25  → 2.50" in format_report(report)


def test_a_row_without_a_1h_cache_write_rate_is_compared_at_its_cache_write_rate():
    # Production bills a 1-hour cache write at the cacheWrite rate when a row has none.
    same = row("claude-x", "anthropic")
    same["prices"]["cacheWrite"] = 2e-6
    lower = row("claude-y", "anthropic")
    lower["prices"]["cacheWrite"] = 1.25e-6
    litellm = {
        name: ll_entry(
            "anthropic",
            cache_creation_input_token_cost=rate,
            cache_creation_input_token_cost_above_1hr=2e-6,
        )
        for name, rate in (("claude-x", 2e-6), ("claude-y", 1.25e-6))
    }
    report = report_for([same, lower], litellm, md_catalog())

    assert [(f["model"], f["field"], f["ours"]) for f in report["flagged"]] == [
        ("claude-y", "cacheWrite1h", None)
    ]


def test_lookup_tries_patterns_in_model_name_order():
    # The worker reads rows ordered by modelName, whatever their order in the file.
    later = row("model-b", "openai", pattern=r"(?i)^model-.*$")
    earlier = row("model-a", "openai", pattern=r"(?i)^model-.*$")

    assert lookup([later, earlier], "model-z") is earlier


def test_an_id_two_patterns_match_at_different_prices_is_an_overlap():
    # The older rows' patterns, meant for dated snapshots, also match the newer versions.
    broad = row("claude-g", "anthropic", input_=1e-5, pattern=r"(?i)^claude-g(-[\d-]+)?$")
    newer = row("claude-g-2", "anthropic", input_=8e-6, pattern=r"(?i)^claude-g-2(-\d+)?$")
    same = row("claude-h", "anthropic", pattern=r"(?i)^claude-h(-[\d-]+)?$")
    copy = row("claude-h-2", "anthropic", pattern=r"(?i)^claude-h-2(-\d+)?$")
    litellm = {
        "claude-g": ll_entry("anthropic", input_=1e-5),
        "claude-g-2-20260101": ll_entry("anthropic", input_=8e-6),
        "claude-h-2-20260101": ll_entry("anthropic"),
    }
    report = report_for([broad, newer, same, copy], litellm, md_catalog())

    # Both rows match the dated ID; at the same price an overlap does no harm.
    assert report["overlaps"] == [
        {"model": "claude-g-2-20260101", "rows": ["claude-g", "claude-g-2"]}
    ]
    assert "claude-g-2-20260101 is matched by claude-g and claude-g-2" in format_report(report)


def test_ids_other_hosts_serve_a_model_under_must_match_its_row():
    rows = [
        row("claude-k-5", "anthropic", pattern=r"(?i)^(anthropic[/.])?claude-k-5$"),
        row("claude-k-5-1", "anthropic", input_=3e-6, pattern=r"(?i)^claude-k-5-1$"),
        row(
            "claude-j",
            "anthropic",
            input_=9e-6,
            pattern=r"(?i)^(claude-j|((eu|us)\.)?anthropic\.claude-[jk]-5-1)$",
        ),
    ]
    litellm = {
        "claude-k-5": ll_entry("anthropic"),
        "anthropic.claude-k-5": ll_entry("bedrock_converse"),  # the row matches it
        "us.anthropic.claude-k-5": ll_entry("bedrock_converse"),
        "bedrock/us-gov-west-1/us-gov.anthropic.claude-k-5-v1:0": ll_entry("bedrock"),
        "eu.anthropic.claude-k-5-1": ll_entry("bedrock_converse"),  # another row's pattern
        "jp.anthropic.claude-k-5": ll_entry("bedrock_converse", deprecation_date="2026-01-01"),
        "vertex_ai/claude-k-5@default": ll_entry("vertex_ai-anthropic_models"),
        "vertex_ai/claude-k-5@20260101": ll_entry("vertex_ai-anthropic_models"),
        "azure_ai/claude-k-5": ll_entry("azure_ai"),
    }
    modelsdev = md_catalog(
        openrouter={
            "anthropic/claude-k-5": md_model(),
            "anthropic/claude-k-5.1": md_model(),
            "anthropic/claude-k-5:free": md_model(),
            "~anthropic/claude-k-latest": md_model(),
        }
    )
    report = report_for(rows, litellm, modelsdev)

    found = [(i["model"], i["row"], i["source"], i["priced_as"]) for i in report["unpriced_ids"]]
    assert found == [
        ("anthropic/claude-k-5.1", "claude-k-5-1", "OpenRouter", None),
        ("claude-k-5@20260101", "claude-k-5", "Vertex AI", None),
        ("eu.anthropic.claude-k-5-1", "claude-k-5-1", "Bedrock", "claude-j"),
        ("us-gov.anthropic.claude-k-5-v1:0", "claude-k-5", "Bedrock", None),
        ("us.anthropic.claude-k-5", "claude-k-5", "Bedrock", None),
    ]
    # Each kind of ID is a section named as the summary counts it, in every format.
    summary = "4 model IDs with no price, 1 model ID priced as another model"
    text = format_report(report)
    assert text.startswith(f"*Model pricing audit, {DATE}*: {summary}\n")
    assert "\n*Model IDs with no price* (4): " in text
    assert "\n*Model IDs priced as another model* (1): " in text
    page = build_html(report)
    assert "<h2>Model IDs with no price (4)</h2>" in page
    assert "<h2>Model IDs priced as another model (1)</h2>" in page
    assert build_payload(report)["text"].endswith(f": {summary}")
    # One example per row, preferring a US Bedrock profile.
    assert "• claude-k-5: 1 Vertex AI, 2 Bedrock, e.g. `us.anthropic.claude-k-5`\n" in text
    assert "• claude-k-5-1: 1 OpenRouter, e.g. `anthropic/claude-k-5.1`\n" in text
    assert "• claude-k-5-1: eu.anthropic.claude-k-5-1 is priced as claude-j\n" in text
    needs = _block_text(build_payload(report)["blocks"][1])
    assert (
        "• *4 model IDs with no price:* Bedrock, Vertex AI and OpenRouter IDs of 2 models we "
        "price, e.g. `us.anthropic.claude-k-5`"
    ) in needs
    assert (
        "• *1 model ID priced as another model*, e.g. `claude-k-5-1`: "
        "`eu.anthropic.claude-k-5-1` is priced as `claude-j`"
    ) in needs


def test_an_id_another_row_prices_the_same_is_not_flagged():
    rows = [
        row("claude-k-5", "anthropic"),
        row("claude-j", "anthropic", pattern=r"(?i)^(claude-j|us\.anthropic\.claude-k-5)$"),
    ]
    litellm = {
        "claude-k-5": ll_entry("anthropic"),
        "us.anthropic.claude-k-5": ll_entry("bedrock_converse"),
    }
    # claude-j's pattern takes claude-k-5's Bedrock ID, at the same prices.
    assert report_for(rows, litellm, md_catalog())["unpriced_ids"] == []

    rows[1]["prices"]["input"] = 9e-6
    found = report_for(rows, litellm, md_catalog())["unpriced_ids"]
    assert [(i["model"], i["priced_as"]) for i in found] == [
        ("us.anthropic.claude-k-5", "claude-j")
    ]


def test_models_with_a_1m_context_window_need_their_1m_id_priced():
    rows = [
        row("claude-l", "anthropic"),
        row("claude-m", "anthropic", pattern=r"(?i)^claude-m(\[1m\])?$"),
        row("claude-n", "anthropic"),
    ]
    litellm = {
        "claude-l": ll_entry("anthropic", max_input_tokens=1_000_000),
        "claude-m": ll_entry("anthropic", max_input_tokens=1_000_000),
        "claude-n": ll_entry("anthropic", max_input_tokens=200_000),
    }
    report = report_for(rows, litellm, md_catalog())

    assert [(i["model"], i["source"]) for i in report["unpriced_ids"]] == [
        ("claude-l[1m]", "1M context")
    ]
    assert "• claude-l: [1m]" in format_report(report)

    litellm["us.anthropic.claude-l"] = ll_entry("bedrock_converse")
    text = format_report(report_for(rows, litellm, md_catalog()))
    assert "• claude-l: 1 Bedrock, e.g. `us.anthropic.claude-l`, [1m]" in text


def test_price_file_problems_are_found_without_a_catalog():
    unit_slip = row("gpt-p", "openai", input_=3.0)
    rows = [
        row("gpt-a", "openai"),
        row("GPT-A", "openai"),
        row("gpt-b", "openai", pattern="("),
        row("gpt-c", "openai", pattern=r"(?i)^(?P<name>gpt-c)$"),
        row("gpt-d", "openai", pattern=r"(?i)^gpt-e$"),
        unit_slip,
        row("gpt-q", "openai", input_=1e-6, cache_read=2e-6),
    ]
    report = report_for(rows, {"gpt-a": ll_entry("openai")}, md_catalog())

    assert [(p["row"], p["problem"]) for p in report["row_problems"]] == [
        ("GPT-A", "modelName is listed twice"),
        ("gpt-b", "matchPattern does not compile, so the row matches its exact name only"),
        ("gpt-c", "matchPattern uses regex syntax the UI cannot read the same way"),
        ("gpt-d", "matchPattern does not match the row's own modelName"),
        ("gpt-p", "input rate is outside $0-$1,000 per 1M tokens"),
        ("gpt-q", "cache read rate is above the input rate"),
    ]
    assert format_report(report).startswith(
        f"*Model pricing audit, {DATE}*: 6 price file problems\n"
    )


def test_regex_syntax_javascript_reads_differently_is_flagged():
    # The UI strips one leading (?i) and compiles the rest with JavaScript's RegExp.
    rejected = [
        r"(?i)^gpt-j\z",  # a literal z in JavaScript
        r"(?i)(?i)^gpt-j$",
        r"(?is)^gpt-j$",
        r"(?i)^(?i:openai\/)?gpt-j$",
        r"(?i)^(?-i:gpt)-j$",
        r"(?i)^(openai\/)?(?(1)gpt|gpt)-j$",
        r"(?i)^gpt-j(-\d{,8})?$",
    ]
    accepted = [r"(?i)^(?:openai\/)?gpt-j(?!-mini)(-\d{1,8})?$", r"^gpt-j$"]

    assert [p for p in rejected if not JS_INCOMPATIBLE.search(p)] == []
    assert [p for p in accepted if JS_INCOMPATIBLE.search(p)] == []


def test_a_plus_after_an_escaped_character_is_not_a_possessive_quantifier():
    # \++ is one or more "+"; \\++ is one or more "\", repeated possessively.
    possessive = [r"(?i)^gpt-j\d++$", r"(?i)^gpt\\++j$"]
    escaped = [r"(?i)^gpt\++j$", r"(?i)^gpt\\\++j$", r"(?i)^gpt-j\{2\}+$"]

    assert [p for p in possessive if not JS_INCOMPATIBLE.search(p)] == []
    assert [p for p in escaped if JS_INCOMPATIBLE.search(p)] == []


def test_long_context_rates_are_listed():
    rows = [row("gpt-r", "openai"), row("gpt-s", "openai"), row("gemini-t", "google")]
    litellm = {
        "gpt-r": ll_entry("openai", input_cost_per_token_above_272k_tokens=2e-6),
        "gpt-s": ll_entry("openai", input_cost_per_token_above_272k_tokens_batches=1e-6),
    }
    modelsdev = md_catalog(
        openai={"gpt-r": md_model(cost={"context_over_200k": {"input": 2.0}})},
        google={"gemini-t": md_model(cost={"context_over_200k": {"input": 2.0}})},
    )
    report = report_for(rows, litellm, modelsdev)

    # LiteLLM's named threshold wins; batch-only tiers don't count.
    assert [(i["model"], i["above"]) for i in report["long_context"]] == [
        ("gpt-r", 272_000),
        ("gemini-t", 200_000),
    ]
    text = format_report(report)
    assert "\n*Long-context rates* (2): " in text
    assert "\ngpt-r over 272K, gemini-t over 200K\n" in text


def test_retired_models_are_not_missing():
    rows = [row("gpt-a", "openai")]
    litellm = {
        "gpt-a": ll_entry("openai"),
        "gpt-gone": ll_entry("openai", deprecation_date="2026-01-31"),
        "gpt-today": ll_entry("openai", deprecation_date=DATE),
        "gpt-later": ll_entry("openai", deprecation_date="2027-06-30"),
        # Retired in one catalog is enough, even when the other still lists it.
        "claude-old": ll_entry("anthropic", deprecation_date="2025-12-01"),
    }
    modelsdev = md_catalog(
        anthropic={"claude-old": md_model()},
        zai={"glm-old": md_model(status="deprecated"), "glm-beta": md_model(status="beta")},
    )
    report = report_for(rows, litellm, modelsdev)

    assert [m["model"] for m in report["missing"]] == ["gpt-later", "glm-beta"]


def test_too_few_rows_compared_fails():
    rows = [row("gpt-a", "openai"), row("gpt-b", "openai")]
    litellm = {"gpt-a": ll_entry("openai")}
    with pytest.raises(CheckError, match="floor of 2"):
        report_for(rows, litellm, md_catalog(), min_compared=2)
