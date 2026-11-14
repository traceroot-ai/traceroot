"""Tests for loading the price file and the catalogs: what is indexed, and that a
format change fails the run instead of reporting all clear."""

import io
import json

import pytest

from scripts.model_prices import catalogs
from scripts.model_prices.catalogs import (
    CheckError,
    fetch_json,
    index_hosted,
    index_litellm,
    index_modelsdev,
    validate_rows,
)
from tests.model_prices.samples import (
    LITELLM_FILLER,
    ll_entry,
    md_catalog,
    md_model,
    report_for,
    row,
)


def test_a_bare_litellm_key_wins_over_a_provider_prefixed_one():
    rates = {"deepseek-d": 1e-6, "deepseek/deepseek-d": 9e-6}
    # Whichever key comes first in the catalog.
    for keys in (rates, reversed(rates)):
        litellm = {key: ll_entry("deepseek", input_=rates[key]) for key in keys}
        index = index_litellm({**LITELLM_FILLER, **litellm})
        assert index[("deepseek", "deepseek-d")]["rates"]["input"] == 1e-6


def test_a_host_ids_key_without_a_region_wins_over_its_region_routes():
    # LiteLLM lists an ID's region routes before its key with no region, which is bare
    # or carries only the provider prefix.
    litellm = {
        "bedrock/ap-northeast-1/moonshotai.kimi-k2-thinking": ll_entry(
            "bedrock", input_=7.3e-7, output=3.03e-6
        ),
        "bedrock/moonshotai.kimi-k2-thinking": ll_entry("bedrock", input_=6e-7, output=2.5e-6),
        "bedrock/ap-south-1/moonshotai.kimi-k2-thinking": ll_entry(
            "bedrock", input_=7.1e-7, output=2.94e-6
        ),
        "bedrock/us-gov-west-1/anthropic.claude-k-5": ll_entry(
            "bedrock", input_=2.4e-6, output=1.2e-5
        ),
        "anthropic.claude-k-5": ll_entry("bedrock_converse", input_=2e-6, output=1e-5),
        "bedrock/eu-west-3/anthropic.claude-k-5": ll_entry("bedrock", input_=2.6e-6, output=1.3e-5),
    }
    hosted = index_hosted(litellm, md_catalog())

    assert {
        model_id: (entry["rates"]["litellm"]["input"], entry["rates"]["litellm"]["output"])
        for model_id, entry in hosted.items()
    } == {"moonshotai.kimi-k2-thinking": (6e-7, 2.5e-6), "anthropic.claude-k-5": (2e-6, 1e-5)}


@pytest.mark.parametrize("bare_first", [True, False], ids=["bare-first", "prefixed-first"])
def test_a_host_ids_bare_key_wins_over_its_provider_prefixed_key(bare_first):
    keys = {
        "anthropic.claude-k-5": ll_entry("bedrock_converse", input_=2e-6, output=1e-5),
        "bedrock/anthropic.claude-k-5": ll_entry("bedrock", input_=2.2e-6, output=1.1e-5),
    }
    litellm = dict(keys.items() if bare_first else reversed(keys.items()))
    rates = index_hosted(litellm, md_catalog())["anthropic.claude-k-5"]["rates"]["litellm"]

    assert (rates["input"], rates["output"]) == (2e-6, 1e-5)


def test_a_catalogs_non_finite_rate_counts_as_absent():
    # JSON parsers accept NaN and Infinity, and read 1e999 as infinity.
    rows = [row("gpt-a", "openai"), row("gpt-b", "openai")]
    litellm = {
        "gpt-a": ll_entry("openai", input_=json.loads("1e999")),
        "gpt-b": ll_entry("openai", input_=2e-6),
    }
    modelsdev = md_catalog(
        openai={"gpt-a": md_model(input_=2e-6), "gpt-b": md_model(input_=json.loads("NaN"))}
    )
    report = report_for(rows, litellm, modelsdev)

    # The other catalog decides, and it disagrees with ours.
    assert [(f["model"], f["field"], f["litellm"], f["modelsdev"]) for f in report["flagged"]] == [
        ("gpt-a", "input", None, pytest.approx(2e-6)),
        ("gpt-b", "input", pytest.approx(2e-6), None),
    ]


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


def test_price_file_format_change_fails():
    good = row("gpt-a", "openai")
    assert validate_rows([good]) == [good]

    no_pattern = {k: v for k, v in good.items() if k != "matchPattern"}
    with pytest.raises(CheckError, match="matchPattern"):
        validate_rows([no_pattern])

    no_input = {**good, "prices": {**good["prices"], "input": None}}
    with pytest.raises(CheckError, match=r"prices\.input"):
        validate_rows([no_input])


@pytest.mark.parametrize(
    "rate", [float("nan"), float("inf"), 10**400], ids=["nan", "infinity", "too-large-for-a-float"]
)
def test_a_rate_that_is_not_a_finite_number_fails_validation(rate):
    with pytest.raises(CheckError, match=r"non-numeric prices\.input"):
        validate_rows([row("gpt-a", "openai", input_=rate)])


def test_catalog_field_missing_everywhere_fails():
    renamed = {"gpt-a": {**ll_entry("openai"), "input_cost_per_token": None}}
    with pytest.raises(CheckError, match="input_cost_per_token"):
        index_litellm(renamed)

    no_provider = md_catalog(openai={"gpt-a": md_model()})
    del no_provider["moonshotai"]
    with pytest.raises(CheckError, match="moonshotai"):
        index_modelsdev(no_provider)


def test_a_price_file_over_the_size_limit_is_not_read(monkeypatch):
    # An open PR's price file is capped, so one huge file can't stall the run.
    monkeypatch.setattr(catalogs, "urlopen", lambda request, timeout: io.BytesIO(b"[   ]"))

    with pytest.raises(CheckError, match="over 4 bytes"):
        fetch_json("https://raw.test/prices.json", max_bytes=4)
    assert fetch_json("https://raw.test/prices.json", max_bytes=5) == []


def test_a_row_name_that_is_not_text_fails_validation():
    with pytest.raises(CheckError, match="row #0 has a non-text modelName"):
        validate_rows([{**row("gpt-a", "openai"), "modelName": 5}])
