"""Small verbatim slices of today's LiteLLM and models.dev catalogs, indexed through the
same functions the CLI uses, so the parsers are proven against the real entry shapes and
not only the synthetic ones in samples.py."""

import json
from datetime import datetime
from pathlib import Path

import pytest

from scripts.model_prices.catalogs import index_hosted, index_litellm, index_modelsdev

FIXTURES = Path(__file__).parent / "fixtures"
LITELLM = json.loads((FIXTURES / "litellm_slice.json").read_text(encoding="utf-8"))
MODELSDEV = json.loads((FIXTURES / "modelsdev_slice.json").read_text(encoding="utf-8"))


def test_litellm_first_party_rates_are_per_token():
    index = index_litellm(LITELLM)

    assert index[("anthropic", "claude-sonnet-5-5")]["rates"] == {
        "input": 2e-06,
        "output": 1e-05,
        "cacheRead": 1e-07,
        "cacheWrite": 2.5e-06,
        "cacheWrite1h": 4e-06,
    }
    assert index[("openai", "gpt-5.5")]["rates"] == {
        "input": 5e-06,
        "output": 3e-05,
        "cacheRead": 5e-07,
        "cacheWrite": None,
        "cacheWrite1h": None,
    }
    assert index[("openai", "gpt-4o")]["retired_from"] == datetime(2027, 1, 14)


def test_litellm_prefixed_keys_lose_their_provider_prefix():
    index = index_litellm(LITELLM)

    assert index[("google", "gemini-2.5-pro")]["rates"]["input"] == 1.25e-06
    assert index[("xai", "grok-4.3")]["text"] is True
    assert ("google", "gemini/gemini-2.5-pro") not in index


def test_litellm_hosts_and_the_sample_spec_stay_out_of_the_index():
    index = index_litellm(LITELLM)

    assert {provider for provider, _ in index} == {
        "anthropic",
        "openai",
        "google",
        "xai",
        "deepseek",
        "moonshot",
        "zai",
    }
    assert all("/" not in model_id and "@" not in model_id for _, model_id in index)


def test_litellm_long_context_threshold_comes_from_the_above_200k_keys():
    index = index_litellm(LITELLM)

    assert index[("google", "gemini-2.5-pro")]["long_context"] == 200_000
    assert index[("anthropic", "claude-sonnet-5-5")]["long_context"] is None


def test_modelsdev_first_party_rates_are_converted_from_per_million():
    index = index_modelsdev(MODELSDEV)

    rates = index[("anthropic", "claude-sonnet-5-5")]["rates"]
    assert rates["input"] == pytest.approx(2e-06)
    assert rates["output"] == pytest.approx(1e-05)
    assert rates["cacheRead"] == pytest.approx(1e-07)
    assert rates["cacheWrite"] == pytest.approx(2.5e-06)
    assert rates["cacheWrite1h"] is None
    assert index[("anthropic", "claude-sonnet-5-5")]["context"] == 1_000_000
    assert index[("openai", "gpt-5.5")]["rates"]["output"] == pytest.approx(3e-05)


def test_modelsdev_long_context_comes_from_cost_context_over_200k():
    index = index_modelsdev(MODELSDEV)

    assert index[("google", "gemini-2.5-pro")]["long_context"] == 200_000
    assert index[("google", "gemini-2.5-pro")]["rates"]["input"] == pytest.approx(1.25e-06)
    assert index[("anthropic", "claude-sonnet-5-5")]["long_context"] is None


def test_modelsdev_marks_deprecated_models_retired():
    index = index_modelsdev(MODELSDEV)

    assert index[("anthropic", "claude-sonnet-4-5")]["retired_from"] == datetime.min
    assert index[("anthropic", "claude-sonnet-5-5")]["retired_from"] is None


def test_bedrock_ids_from_every_litellm_route_map_to_bedrock():
    hosted = index_hosted(LITELLM, MODELSDEV)

    # bedrock_converse, with the region prefix kept in the ID.
    assert hosted["us.anthropic.claude-sonnet-4-5-20250929-v1:0"] == {
        "host": "Bedrock",
        "text": True,
        "retired_from": datetime(2027, 4, 8),
    }
    # bedrock/us-gov-west-1/<id>, bedrock_mantle/<id> and bedrock_mantle/us-gov-west-1/<id>
    # all land on the bare model ID.
    assert hosted["anthropic.claude-sonnet-5-5"]["host"] == "Bedrock"
    assert hosted["openai.gpt-5.5"]["host"] == "Bedrock"


def test_modelsdev_bedrock_and_openrouter_ids_carry_their_host():
    hosted = index_hosted(LITELLM, MODELSDEV)

    assert hosted["us.anthropic.claude-sonnet-5-5"] == {
        "host": "Bedrock",
        "text": True,
        "retired_from": None,
    }
    assert hosted["us-gov.openai.gpt-oss-120b-1:0"]["host"] == "Bedrock"
    assert hosted["anthropic/claude-sonnet-5.5"]["host"] == "OpenRouter"


def test_vertex_default_placeholders_and_openrouter_variants_are_not_hosted_ids():
    hosted = index_hosted(LITELLM, MODELSDEV)

    assert "claude-sonnet-5-5@default" not in hosted
    assert not [model_id for model_id in hosted if model_id.endswith("@default")]
    # A pinned Vertex version is an ID a span can carry.
    assert hosted["claude-sonnet-4-5@20250929"]["host"] == "Vertex AI"
    # An alias entry has no litellm_provider, and OpenRouter's variants are left out.
    assert "claude-sonnet-latest" not in hosted
    assert "thinkingmachines/inkling-2-small:free" not in hosted
    assert "~google/gemini-pro-latest" not in hosted


def test_first_party_ids_are_not_hosted_ids():
    hosted = index_hosted(LITELLM, MODELSDEV)

    assert "claude-sonnet-5-5" not in hosted
    assert "gpt-5.5" not in hosted
