"""Unit tests for scripts/check_model_prices.py: compare the standard model price file
with two public price catalogs, flag a rate only when every catalog that lists the
model disagrees, list catalog models and model IDs we do not price, check the price
file itself, name the open PRs that fix each finding, and fail loudly, never as an
all-clear, when a format changes.

Every test uses small inline samples. None reads the real price file or the network.
"""

import io
import json
import signal
import subprocess
import sys
from pathlib import Path
from urllib.error import HTTPError, URLError

import pytest

import scripts.check_model_prices as check
from scripts.check_model_prices import (
    CheckError,
    apply_pr,
    build_payload,
    build_report,
    differs,
    format_report,
    index_hosted,
    index_litellm,
    index_modelsdev,
    lookup,
    post_to_slack,
    track,
    validate_rows,
)

REPO_ROOT = Path(__file__).resolve().parent.parent
SCRIPT = REPO_ROOT / "scripts" / "check_model_prices.py"
DATE = "2026-11-08"


def row(model, provider, *, input_=1e-6, output=2e-6, cache_read=1e-7, pattern=None):
    return {
        "id": f"tr-{model}",
        "modelName": model,
        "matchPattern": pattern or f"(?i)^({provider}\\/)?{model}$",
        "provider": provider,
        "prices": {"input": input_, "output": output, "cacheRead": cache_read, "cacheWrite": None},
    }


def ll_entry(provider, input_=1e-6, output=2e-6, cache_read=1e-7, mode="chat", **extra):
    return {
        "litellm_provider": provider,
        "mode": mode,
        "input_cost_per_token": input_,
        "output_cost_per_token": output,
        "cache_read_input_token_cost": cache_read,
        **extra,
    }


def md_model(input_=1e-6, output=2e-6, cache_read=1e-7, outputs=("text",), cost=(), **extra):
    rates = {"input": input_ * 1e6, "output": output * 1e6, **dict(cost)}
    if cache_read is not None:
        rates["cache_read"] = cache_read * 1e6
    return {"cost": rates, "modalities": {"input": ["text"], "output": list(outputs)}, **extra}


# Each catalog must have every compared rate somewhere, or the run fails as a format
# change. These fillers carry them; neither is a text model, so neither is "missing".
CACHE_WRITE_RATES = {
    "cache_creation_input_token_cost": 1e-6,
    "cache_creation_input_token_cost_above_1hr": 2e-6,
}
LITELLM_FILLER = {
    "text-embedding-filler": ll_entry("openai", mode="embedding", **CACHE_WRITE_RATES)
}


def md_catalog(**providers):
    keys = ("openai", "anthropic", "google", "xai", "deepseek", "zai", "moonshotai")
    catalog = {key: {"models": {}} for key in keys}
    catalog["zai"]["models"]["glm-filler"] = md_model(outputs=("image",), cost={"cache_write": 1.0})
    for key, models in providers.items():
        catalog.setdefault(key, {"models": {}})["models"].update(models)
    return catalog


def report_for(rows, litellm, modelsdev, min_compared=1):
    litellm = {**LITELLM_FILLER, **litellm}
    return build_report(
        rows,
        index_litellm(litellm),
        index_modelsdev(modelsdev),
        date=DATE,
        hosted=index_hosted(litellm, modelsdev),
        min_compared=min_compared,
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
    assert flag["pricing_page"] == check.PRICING_PAGES["openai"]


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


def test_other_catalog_providers_are_ignored():
    rows = [row("gemini-c", "google")]
    litellm = {
        "gemini/gemini-c": ll_entry("gemini"),
        # Region-priced and reseller copies of the same model must not be compared.
        "vertex_ai/gemini-c": ll_entry("vertex_ai-language-models", input_=9e-6),
        "azure/gemini-c": ll_entry("azure", input_=9e-6),
    }
    modelsdev = md_catalog()
    modelsdev["google-vertex"] = {"models": {"gemini-c": md_model(input_=9e-6)}}
    report = report_for(rows, litellm, modelsdev)

    assert report["compared"] == 1
    assert report["flagged"] == []


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
    assert report["flagged"][0]["pricing_page"] == check.PRICING_PAGES["anthropic"]
    assert "claude-f-2 (priced as claude-f)  input" in format_report(report)
    table = next(b for b in build_payload(report)["blocks"] if b["type"] == "table")
    assert table["rows"][1][0]["elements"][0]["elements"] == [
        {"type": "link", "url": check.PRICING_PAGES["anthropic"], "text": "claude-f-2"},
        {"type": "text", "text": " (priced as claude-f)", "style": {"italic": True}},
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
    text = format_report(report)
    assert f"*Model IDs not priced by their row* (5): {check.ID_HEADING}" in text
    assert "<h2>Model IDs not priced by their row (5)</h2>" in check.build_html(report)
    assert build_payload(report)["text"].endswith(
        ": 4 model IDs with no price, 1 model ID priced as another model"
    )
    # One example per row, preferring a US Bedrock profile.
    assert "• claude-k-5: 1 Vertex AI, 2 Bedrock, e.g. `us.anthropic.claude-k-5`" in text
    assert (
        "• claude-k-5-1: 1 OpenRouter, e.g. `anthropic/claude-k-5.1`, "
        "`eu.anthropic.claude-k-5-1` is priced as claude-j"
    ) in text
    needs = _block_text(build_payload(report)["blocks"][1])
    assert (
        "• *4 model IDs record no cost.* These are the Bedrock, Vertex AI and OpenRouter IDs "
        "of 2 models we already price: Anthropic 4. Example: `us.anthropic.claude-k-5`"
    ) in needs
    assert (
        "• *1 model ID gets another model's price*, e.g. `eu.anthropic.claude-k-5-1` is "
        "priced as `claude-j`"
    ) in needs


def test_long_lists_are_cut_at_a_whole_line_with_a_count():
    lines = [f"• row-{n}: 3 Bedrock" for n in range(40)]
    text = check._fit("*Heading*", lines, 200)

    assert len(text) <= 200
    assert text.startswith("*Heading*\n• row-0: 3 Bedrock\n")
    kept = text.count("• row-")
    assert text.endswith(f"\n…and {40 - kept} more in the JSON report")
    assert check._fit("*Heading*", lines[:2], 200) == "*Heading*\n" + "\n".join(lines[:2])


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
        f"*Model pricing audit, {DATE}*: prices match the catalogs, 6 price file problems"
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

    assert [p for p in rejected if not check.JS_INCOMPATIBLE.search(p)] == []
    assert [p for p in accepted if check.JS_INCOMPATIBLE.search(p)] == []


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
    assert "(2): gpt-r over 272K, gemini-t over 200K" in format_report(report)


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
    assert f"<{check.PRICING_PAGES['deepseek']}|deepseek>" in text


def test_price_file_format_change_fails():
    good = row("gpt-a", "openai")
    assert validate_rows([good]) == [good]

    no_pattern = {k: v for k, v in good.items() if k != "matchPattern"}
    with pytest.raises(CheckError, match="matchPattern"):
        validate_rows([no_pattern])

    no_input = {**good, "prices": {**good["prices"], "input": None}}
    with pytest.raises(CheckError, match=r"prices\.input"):
        validate_rows([no_input])


def test_catalog_field_missing_everywhere_fails():
    renamed = {"gpt-a": {**ll_entry("openai"), "input_cost_per_token": None}}
    with pytest.raises(CheckError, match="input_cost_per_token"):
        index_litellm(renamed)

    no_provider = md_catalog(openai={"gpt-a": md_model()})
    del no_provider["moonshotai"]
    with pytest.raises(CheckError, match="moonshotai"):
        index_modelsdev(no_provider)


def test_too_few_rows_compared_fails():
    rows = [row("gpt-a", "openai"), row("gpt-b", "openai")]
    litellm = {"gpt-a": ll_entry("openai")}
    with pytest.raises(CheckError, match="floor of 2"):
        report_for(rows, litellm, md_catalog(), min_compared=2)


def test_flagged_message_lists_every_rate_and_the_pricing_page():
    rows = [row("deepseek-d", "deepseek", input_=5e-7)]
    litellm = {"deepseek/deepseek-d": ll_entry("deepseek", input_=1e-6)}
    modelsdev = md_catalog(deepseek={"deepseek-d": md_model(input_=1e-6)})
    text = format_report(report_for(rows, litellm, modelsdev))

    assert text.startswith(f"*Model pricing audit, {DATE}*: 1 model with prices to check")
    assert "deepseek-d  input  0.50  → 1.00" in text
    assert f"Pricing pages: <{check.PRICING_PAGES['deepseek']}|deepseek>" in text


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


def _block_text(block):
    if block["type"] == "context":
        return " ".join(element["text"] for element in block["elements"])
    return block.get("text", {}).get("text", "")


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
        "url": check.PRICING_PAGES["deepseek"],
        "text": "deepseek-d",
    }
    assert [c["text"] for c in cells[1][1:]] == ["input", "0.50", "0.66-1.32"]
    assert [c["text"] for c in cells[2]] == [" ", "output", "1.00", "4.00"]

    # Counts only: aliases and realtime models are left to the full report.
    assert _block_text(blocks[3]) == "• *2 models aren't priced at all:* OpenAI 2"
    assert _block_text(blocks[4]) == "<https://pages.test/r|Full report> · Checked 1 of 1 rows"
    assert "<!channel>" not in json.dumps(payload)


def test_slack_message_stays_within_block_kit_limits():
    rows = [row(f"gpt-{n}", "openai", input_=5e-7) for n in range(30)]
    litellm = {f"gpt-{n}": ll_entry("openai") for n in range(30)}
    litellm.update({f"gpt-unpriced-model-{n:03d}": ll_entry("openai") for n in range(300)})
    litellm.update({f"gpt-unpriced-model-{n:03d}-latest": ll_entry("openai") for n in range(300)})
    blocks = build_payload(report_for(rows, litellm, md_catalog()))["blocks"]

    assert len(blocks) <= 50
    table = next(b for b in blocks if b["type"] == "table")
    assert len(table["rows"]) == check.MAX_FLAGGED_LINES + 1
    assert "…and 10 more rates" in _block_text(
        next(b for b in blocks if b.get("block_id") == "prices_more")
    )
    for block in blocks:
        limit = {"header": 150, "section": 3000, "context": 2000}.get(block["type"])
        if limit:
            assert len(_block_text(block)) <= limit, block["type"]


# --- --track: open PRs that fix a finding -----------------------------------------


def test_a_pr_is_merged_by_its_own_row_changes():
    base = [row("gpt-a", "openai"), row("gpt-b", "openai"), row("gpt-c", "openai")]
    # Since the PR branched, the current file changed gpt-a and gained gpt-new.
    current = [row("gpt-a", "openai", input_=5e-6), *base[1:], row("gpt-new", "openai")]
    head = [base[0], row("gpt-b", "openai", input_=7e-6), row("gpt-d", "openai")]

    merged = apply_pr(current, base, head)

    assert [(r["modelName"], r["prices"]["input"]) for r in merged] == [
        ("gpt-a", 5e-6),  # left as the current file has it
        ("gpt-b", 7e-6),  # the PR's change
        ("gpt-new", 1e-6),
        ("gpt-d", 1e-6),  # the PR's new row; gpt-c, which it removed, is gone
    ]


def test_a_pr_changes_only_the_fields_it_changed_in_a_row():
    # The PR branched when both rates were wrong. The current file has since fixed the
    # cache read rate, and the PR fixes the input rate and drops the 1-hour cache write.
    base = [row("deepseek-d", "deepseek", input_=5e-7, cache_read=1e-8)]
    base[0]["prices"]["cacheWrite1h"] = 2e-6
    current = [row("deepseek-d", "deepseek", input_=5e-7, cache_read=1e-7)]
    current[0]["prices"]["cacheWrite1h"] = 2e-6
    head = [row("deepseek-d", "deepseek", input_=1e-6, cache_read=1e-8)]

    merged = apply_pr(current, base, head)

    assert merged[0]["prices"] == {
        "input": 1e-6,
        "output": 2e-6,
        "cacheRead": 1e-7,
        "cacheWrite": None,
    }
    litellm = {"deepseek/deepseek-d": ll_entry("deepseek", input_=1e-6, cache_read=1e-7)}
    [pr] = _track_one_pr(current, litellm, merged)["pull_requests"]
    assert (pr["fixes"], pr["adds"]) == (["deepseek-d input rate"], [])


def _tracked_report():
    rows = [row("deepseek-d", "deepseek", input_=5e-7, output=1e-6), row("gpt-a", "openai")]
    litellm = {
        "deepseek/deepseek-d": ll_entry("deepseek", input_=1e-6, output=2e-6),
        "gpt-a": ll_entry("openai"),
        "gpt-new": ll_entry("openai"),
    }
    catalogs = (index_litellm({**LITELLM_FILLER, **litellm}), index_modelsdev(md_catalog()))

    def evaluate(pr_rows):
        return build_report(pr_rows, *catalogs, date=DATE, min_compared=0)

    fix_input = [row("deepseek-d", "deepseek", input_=1e-6, output=1e-6), rows[1]]
    adds_new = [*fix_input, row("gpt-new", "openai", input_=9e-6)]
    prs = [
        {"number": 11, "url": "https://github.test/pull/11", "closes": [10]},
        {"number": 12, "url": "https://github.test/pull/12", "draft": True},
        {"number": 13, "url": "https://github.test/pull/13", "error": "could not read it"},
    ]
    prs[0]["report"], prs[1]["report"] = evaluate(fix_input), evaluate(adds_new)
    report = evaluate(rows)
    track(report, prs)
    return report


def test_track_names_the_prs_that_clear_each_finding_and_what_they_add():
    report = _tracked_report()

    assert [(f["field"], f["tracked_by"]) for f in report["flagged"]] == [
        ("input", [11, 12]),
        ("output", []),
    ]
    assert report["missing"][0]["tracked_by"] == [12]
    assert [
        (pr["number"], pr["fixes"], pr["adds"], pr.get("error")) for pr in report["pull_requests"]
    ] == [
        (11, ["deepseek-d input rate"], [], None),
        (12, ["deepseek-d input rate", "gpt-new not priced"], ["gpt-new input rate"], None),
        (13, [], [], "could not read it"),
    ]
    assert report["pull_requests"][0]["closes"] == [10]


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


def test_tracked_prs_show_in_the_report_and_the_slack_table():
    report = _tracked_report()
    text = format_report(report)

    assert "1 model with prices to check (1 with an open PR)" in text
    assert "deepseek-d  input   0.50  → 1.00  #11, #12" in text
    assert "\n            output  1.00  → 2.00\n" in text
    assert "• *openai* (1): gpt-new (#12)" in text
    assert "• #12 would add: gpt-new input rate" in text
    assert "• #13: could not read it" in text
    assert "checked 3 open pricing PRs" in text

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
        f"• :warning: {pr(12)} would add: gpt-new input rate",
    ]
    assert _block_text(blocks[4]) == "Checked 2 of 2 rows and 3 open pricing PRs"


def _track_one_pr(rows, litellm, pr_rows):
    """The report for rows, with one open PR, #7, whose price file is pr_rows."""
    catalogs = (index_litellm({**LITELLM_FILLER, **litellm}), index_modelsdev(md_catalog()))

    def evaluate(rows):
        return build_report(rows, *catalogs, date=DATE, min_compared=0)

    report = evaluate(rows)
    track(report, [{"number": 7, "report": evaluate(pr_rows)}])
    return report


def _progress(report):
    blocks = build_payload(report)["blocks"]
    return _block_text(next(b for b in blocks if b.get("block_id") == "progress")).split("\n")


def test_a_rate_our_row_leaves_out_shows_as_none_in_the_progress_line():
    litellm = {"gpt-a": ll_entry("openai", cache_read=5e-7)}
    fixed = [row("gpt-a", "openai", cache_read=5e-7)]
    report = _track_one_pr([row("gpt-a", "openai", cache_read=None)], litellm, fixed)

    assert "• `gpt-a` cache read none → $0.50: #7" in _progress(report)


def test_a_prs_row_name_cannot_add_a_line_to_the_slack_message():
    rows = [row("gpt-a", "openai")]
    forged = row("x\n:large_green_circle: *All clear*", "openai", pattern=r"^nothing$")
    report = _track_one_pr(rows, {"gpt-a": ll_entry("openai")}, [*rows, forged])

    assert _progress(report) == [
        ":large_yellow_circle: *In progress (open PRs)*",
        "• :warning: #7 would add: x :large_green_circle: *All clear*: matchPattern does not "
        "match the row's own modelName",
    ]


def test_the_full_report_page_lists_every_finding():
    report = _tracked_report()
    report["missing"].append({"model": "<b>x</b>", "provider": "openai", "in": ["litellm"]})
    page = check.build_html(report)

    assert page.startswith("<!doctype html>")
    assert "<h2>Prices to check (2)</h2>" in page
    assert '<a href="https://github.test/pull/11">#11</a>' in page
    assert "<h2>Models not priced (2)</h2>" in page
    assert "<code>&lt;b&gt;x&lt;/b&gt;</code>" in page
    assert "<h2>Open pricing PRs (3)</h2>" in page

    failed = check.build_html({"date": DATE, "status": "failed", "error": "catalog <down>"})
    assert "catalog &lt;down&gt;" in failed and "not an all-clear" in failed


def test_fetch_pricing_prs_reads_each_pricing_prs_price_file(monkeypatch):
    rows = [row("gpt-a", "openai")]
    report = build_report(
        rows,
        index_litellm({**LITELLM_FILLER, "gpt-a": ll_entry("openai", input_=2e-6)}),
        index_modelsdev(md_catalog()),
        date=DATE,
        min_compared=0,
    )

    def pull(number, title, body="", files=(check.PRICE_PATH,)):
        return {
            "number": number,
            "title": title,
            "body": body,
            "html_url": f"https://github.test/pull/{number}",
            "draft": False,
            "base": {"sha": f"base{number}"},
            "head": {"sha": f"head{number}"},
            "files": list(files),
        }

    pulls = [
        pull(1, "fix(pricing): gpt-a input rate", "Fixes #9"),
        pull(2, "docs: typo"),
        pull(3, "chore: bump gpt-a in examples", files=("README.md",)),
        pull(4, "fix(pricing): broken branch"),
        pull(5, "fix(pricing): gpt-a odd row"),
    ]
    calls = []

    def fake_github(url, token):
        calls.append(url)
        if "/pulls?" in url:
            return pulls
        number = int(url.rsplit("head", 1)[1])
        files = next(p["files"] for p in pulls if p["number"] == number)
        return {
            "merge_base_commit": {"sha": f"mb{number}"},
            "files": [{"filename": name} for name in files],
        }

    def fake_fetch(url, max_bytes=None):
        assert max_bytes == check.MAX_PRICE_FILE_BYTES
        if "head4" in url:
            raise URLError("gone")
        if "head5" in url:
            return [{**row("gpt-a", "openai"), "modelName": 5}]
        return [row("gpt-a", "openai", input_=2e-6)] if "head" in url else rows

    monkeypatch.setattr(check, "_github", fake_github)
    monkeypatch.setattr(check, "fetch_json", fake_fetch)
    prs = check.fetch_pricing_prs("owner/repo", rows, report, None, lambda r: {"rows": r})

    # PR 2 neither mentions pricing nor a flagged model; PR 3 doesn't touch the file.
    assert [pr["number"] for pr in prs] == [1, 4, 5]
    assert prs[0]["closes"] == [9]
    assert prs[0]["report"]["rows"][0]["prices"]["input"] == 2e-6
    assert prs[1]["error"] == "could not check its price file (URLError)"
    # A row this run can't evaluate makes the PR unreadable instead of failing the run.
    assert prs[2]["error"] == "could not check its price file (CheckError)"
    assert not any("pull/2" in url or "head2" in url for url in calls)


def test_a_price_file_over_the_size_limit_is_not_read(monkeypatch):
    # An open PR's price file is capped, so one huge file can't stall the run.
    monkeypatch.setattr(check, "urlopen", lambda request, timeout: io.BytesIO(b"[   ]"))

    with pytest.raises(CheckError, match="over 4 bytes"):
        check.fetch_json("https://raw.test/prices.json", max_bytes=4)
    assert check.fetch_json("https://raw.test/prices.json", max_bytes=5) == []


def test_a_row_name_that_is_not_text_fails_validation():
    with pytest.raises(check.CheckError, match="row #0 has a non-text modelName"):
        check.validate_rows([{**row("gpt-a", "openai"), "modelName": 5}])


def test_escape_drops_terminal_control_characters():
    # Row names come from open PRs, and the terminal prints the same text as Slack.
    assert check._escape("gpt-\x1b]52;c;eA==\x07a\nb") == "gpt- ]52;c;eA== a b"


def test_github_rate_limit_stops_tracking(monkeypatch):
    def limited(url, token):
        if "/pulls?" in url:
            return [
                {"number": 1, "title": "fix(pricing)", "base": {"sha": "b"}, "head": {"sha": "h"}}
            ]
        raise HTTPError(url, 403, "rate limited", {}, None)

    monkeypatch.setattr(check, "_github", limited)
    report = {
        key: []
        for key in (
            "flagged",
            "unpriced_ids",
            "overlaps",
            "row_problems",
            "missing",
            "long_context",
        )
    }
    with pytest.raises(HTTPError):
        check.fetch_pricing_prs("owner/repo", [], report, None, lambda rows: {})


# --- the command line: main() with the network and Slack replaced ---------------


@pytest.fixture
def run(tmp_path, monkeypatch):
    """Run main() against sample data; returns (exit code, posted payloads, report). With
    heads, GitHub has an open pricing PR for each entry, branched from rows: its number,
    and the price file at its head or the error reading the PR raises."""
    monkeypatch.setenv("SLACK_WEBHOOK_URL", "https://hooks.example.test/T/B/x")
    posted = []
    monkeypatch.setattr(check, "post_to_slack", lambda _url, payload: posted.append(payload))

    def _run(rows, litellm, modelsdev, *extra, heads=None):
        if isinstance(litellm, dict):
            # Only the cache write rates, so a test can still remove any other field.
            filler = {"litellm_provider": "openai", "mode": "embedding", **CACHE_WRITE_RATES}
            litellm = {"cache-write-filler": filler, **litellm}

        def fake_fetch(url, max_bytes=None):
            if isinstance(litellm, Exception):
                raise litellm
            if url in (check.LITELLM_URL, check.MODELSDEV_URL):
                return litellm if url == check.LITELLM_URL else modelsdev
            sha = url.split("/")[5]
            # Through JSON, as GitHub serves it.
            return json.loads(json.dumps(rows if sha == "base" else heads[int(sha[4:])]))

        def fake_github(url, token):
            if "/pulls?" in url:
                return [
                    {
                        "number": number,
                        "title": "fix(pricing): rates",
                        "base": {"sha": "base"},
                        "head": {"sha": f"head{number}"},
                    }
                    for number in heads
                ]
            head = heads[int(url.rsplit("head", 1)[1])]
            if isinstance(head, Exception):
                raise head
            return {"merge_base_commit": {"sha": "base"}, "files": [{"filename": check.PRICE_PATH}]}

        monkeypatch.setattr(check, "fetch_json", fake_fetch)
        if heads is not None:
            monkeypatch.setattr(check, "_github", fake_github)
        prices = tmp_path / "prices.json"
        prices.write_text(json.dumps(rows))
        out = tmp_path / "report.json"
        argv = ["--post", "--prices", str(prices), "--json", str(out), *extra]
        code = check.main(argv)
        return code, posted, json.loads(out.read_text())

    return _run


def test_quiet_day_posts_a_heartbeat(run, tmp_path):
    rows = [row("gpt-a", "openai")]
    saved = tmp_path / "payload.json"
    code, posted, report = run(
        rows,
        {"gpt-a": ll_entry("openai")},
        md_catalog(),
        "--min-compared",
        "1",
        "--payload",
        str(saved),
        "--html",
        str(tmp_path / "report.html"),
        "--report-url",
        "https://pages.test/r",
    )

    assert code == 0
    assert report["status"] == "ok"
    [payload] = posted
    assert payload["text"] == f"Model pricing audit, {report['date']}: prices match the catalogs"
    assert payload["blocks"][1]["text"]["text"] == (
        ":large_green_circle: *Prices match the catalogs, and every model ID is priced*"
    )
    assert "<https://pages.test/r|Full report>" in payload["blocks"][-1]["elements"][0]["text"]
    assert json.loads(saved.read_text()) == payload
    assert "Checked 1 of 1 rows" in (tmp_path / "report.html").read_text()


def test_unreadable_github_still_reports_and_says_prs_were_not_checked(run, monkeypatch):
    def offline(url, token):
        raise URLError("offline")

    monkeypatch.setattr(check, "_github", offline)
    rows = [row("gpt-a", "openai", input_=5e-7)]
    code, posted, report = run(
        rows, {"gpt-a": ll_entry("openai")}, md_catalog(), "--min-compared", "1", "--track"
    )

    assert code == 0
    assert report["tracking"] == "GitHub could not be read (URLError)"
    assert "flagged" in report and report["flagged"][0]["model"] == "gpt-a"
    footer = posted[0]["blocks"][-1]["elements"][0]["text"]
    assert footer.endswith("open PRs not checked: GitHub could not be read (URLError)")


TRACK = ("--min-compared", "1", "--track")
UNCOMPILABLE = "gpt-x: matchPattern does not compile, so the row matches its exact name only"


def _run_with_two_prs(run, second_head):
    """main() with --track on one row, gpt-a, whose input rate is flagged: open PR #1
    fixes it, and PR #2's head has second_head as its price file, or raises it when read."""
    rows = [row("gpt-a", "openai", input_=5e-7)]
    heads = {1: [row("gpt-a", "openai")], 2: second_head}
    return run(rows, {"gpt-a": ll_entry("openai")}, md_catalog(), *TRACK, heads=heads)


@pytest.mark.parametrize(
    ("bad_row", "adds", "error"),
    [
        pytest.param(
            row("gpt-x", "openai", pattern="^gpt-x{4294967296}$"),
            [UNCOMPILABLE],
            "",
            id="repeat-count-too-large",
        ),
        pytest.param(
            row("gpt-x", "openai", pattern="(" * 3000 + "gpt-x" + ")" * 3000),
            [UNCOMPILABLE],
            "",
            id="groups-nested-too-deep",
        ),
        pytest.param(
            row("gpt-x", "openai", input_=10**400),
            [],
            "could not check its price file (",
            id="rate-too-large-for-a-float",
        ),
    ],
)
def test_one_open_prs_bad_row_cannot_fail_the_run(run, bad_row, adds, error):
    code, _, report = _run_with_two_prs(run, [row("gpt-a", "openai", input_=5e-7), bad_row])

    assert code == 0
    assert report["tracking"] == "ok"
    assert report["flagged"][0]["tracked_by"] == [1]
    [_, pr] = report["pull_requests"]
    assert pr["adds"] == adds
    assert pr.get("error", "").startswith(error)


def test_a_failure_checking_one_pr_is_reported_on_that_pr_alone(run, monkeypatch):
    # Whatever goes wrong while checking a PR's rows, the other PRs still count.
    build_report = check.build_report

    def failing(rows, *args, **kwargs):
        if any(r["modelName"] == "gpt-x" for r in rows):
            raise ValueError("unexpected")
        return build_report(rows, *args, **kwargs)

    monkeypatch.setattr(check, "build_report", failing)
    second = [row("gpt-a", "openai", input_=5e-7), row("gpt-x", "openai")]
    code, _, report = _run_with_two_prs(run, second)

    assert code == 0
    assert report["tracking"] == "ok"
    assert report["flagged"][0]["tracked_by"] == [1]
    assert report["pull_requests"][1]["error"] == "could not check its price file (ValueError)"


def test_an_open_prs_price_file_gets_a_time_limit(run, monkeypatch):
    # A pattern that backtracks on a long catalog ID would otherwise stall the run.
    monkeypatch.setattr(check, "PR_CHECK_SECONDS", 0.2, raising=False)
    handler = signal.getsignal(signal.SIGALRM)
    rows = [row("gpt-a", "openai", input_=5e-7)]
    litellm = {"gpt-a": ll_entry("openai"), "a" * 26 + "b": ll_entry("openai")}
    heads = {1: [row("gpt-a", "openai")], 2: [*rows, row("gpt-x", "openai", pattern="^(a+)+$")]}
    code, _, report = run(rows, litellm, md_catalog(), *TRACK, heads=heads)

    assert code == 0
    assert report["flagged"][0]["tracked_by"] == [1]
    assert report["pull_requests"][1]["error"] == "its price file took over 0.2 seconds to check"
    assert signal.getitimer(signal.ITIMER_REAL) == (0.0, 0.0)
    assert signal.getsignal(signal.SIGALRM) is handler


def test_a_rate_limit_partway_through_the_prs_marks_no_finding_as_in_a_pr(run):
    # Findings are marked only once every PR is checked, so none is hidden from the
    # message while the footer says open PRs were not checked.
    limited = HTTPError("https://api.test", 429, "", {}, None)
    code, posted, report = _run_with_two_prs(run, limited)

    assert code == 0
    assert report["tracking"] == "GitHub could not be read (429)"
    assert not report["flagged"][0].get("tracked_by")
    assert posted[0]["text"].endswith(": 1 model with prices to check")


def test_format_change_exits_nonzero_and_posts_a_failure(run):
    rows = [row("gpt-a", "openai")]
    renamed = {"gpt-a": {**ll_entry("openai"), "input_cost_per_token": None}}
    code, posted, report = run(rows, renamed, md_catalog(), "--min-compared", "1")

    assert code == 1
    assert report["status"] == "failed"
    [payload] = posted
    assert payload["text"].startswith(f"Model pricing audit FAILED, {report['date']}: ")
    assert "input_cost_per_token" in payload["text"]
    assert payload["blocks"][0]["text"]["text"] == f"Model pricing audit FAILED · {report['date']}"
    assert "not an all-clear" in payload["blocks"][1]["text"]["text"]


def test_a_failure_reason_is_escaped_in_the_notification_text_too():
    payload = check.failure_payload(DATE, "price file row <!channel> has no modelName")

    assert "<!channel>" not in json.dumps(payload)
    assert payload["text"].endswith(": price file row &lt;!channel&gt; has no modelName")


def test_too_few_rows_compared_exits_nonzero(run):
    rows = [row("gpt-a", "openai")]
    code, posted, _ = run(rows, {"gpt-a": ll_entry("openai")}, md_catalog())

    assert code == 1
    assert "below the floor of 80" in posted[0]["text"]


def test_unreachable_catalog_exits_nonzero(run):
    code, posted, _ = run([row("gpt-a", "openai")], URLError("offline"), md_catalog())

    assert code == 1
    assert "could not load the LiteLLM catalog" in posted[0]["text"]


def test_post_without_webhook_fails_before_fetching(tmp_path, monkeypatch, capsys):
    monkeypatch.delenv("SLACK_WEBHOOK_URL", raising=False)
    monkeypatch.setattr(check, "fetch_json", lambda url: pytest.fail("fetched"))

    assert check.main(["--post", "--prices", str(tmp_path / "unused.json")]) == 1
    assert "SLACK_WEBHOOK_URL" in capsys.readouterr().err


def test_a_malformed_webhook_url_fails_without_printing_it(run, monkeypatch, capsys):
    # The real post: a URL with no scheme raises ValueError before any request is sent.
    monkeypatch.setattr(check, "post_to_slack", post_to_slack)
    monkeypatch.setenv("SLACK_WEBHOOK_URL", "hooks.example.test/T/B/secret")
    code, _, report = run(
        [row("gpt-a", "openai")], {"gpt-a": ll_entry("openai")}, md_catalog(), "--min-compared", "1"
    )

    assert code == 1
    assert report["status"] == "ok"
    output = capsys.readouterr()
    assert "Slack post failed (ValueError)" in output.err
    assert "secret" not in output.out + output.err


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

    monkeypatch.setattr(check, "urlopen", fake_urlopen)
    payload = {"text": "hello", "blocks": [{"type": "divider"}]}
    check.post_to_slack("https://hooks.example.test/T/B/x", payload)

    [request] = sent
    assert request.get_method() == "POST"
    assert request.get_header("Content-type") == "application/json"
    assert json.loads(request.data) == payload


def test_runs_as_a_plain_script():
    """Standard library only: runs with no venv packages and no PYTHONPATH."""
    result = subprocess.run(
        [sys.executable, "-S", str(SCRIPT), "--help"],
        cwd=REPO_ROOT,
        env={"PATH": "/usr/bin:/bin"},
        capture_output=True,
        text=True,
    )
    assert result.returncode == 0, result.stderr
    assert "--post" in result.stdout
