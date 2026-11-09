"""Unit tests for scripts/check_model_prices.py: compare the standard model price file
with two public price catalogs, flag a rate only when every catalog that lists the
model disagrees, list catalog models we do not price, and fail loudly, never as an
all-clear, when a format changes.

Every test uses small inline samples. None reads the real price file or the network.
"""

import json
import subprocess
import sys
from pathlib import Path
from urllib.error import URLError

import pytest

import scripts.check_model_prices as check
from scripts.check_model_prices import (
    CheckError,
    build_report,
    differs,
    format_report,
    index_litellm,
    index_modelsdev,
    lookup,
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


def md_model(input_=1e-6, output=2e-6, cache_read=1e-7, outputs=("text",), **extra):
    cost = {"input": input_ * 1e6, "output": output * 1e6}
    if cache_read is not None:
        cost["cache_read"] = cache_read * 1e6
    return {"cost": cost, "modalities": {"input": ["text"], "output": list(outputs)}, **extra}


# Each catalog must have every compared rate somewhere, or the run fails as a format
# change. These fillers carry them; neither is a text model, so neither is "missing".
LITELLM_FILLER = {"text-embedding-filler": ll_entry("openai", mode="embedding")}


def md_catalog(**providers):
    keys = ("openai", "anthropic", "google", "xai", "deepseek", "zai", "moonshotai")
    catalog = {key: {"models": {}} for key in keys}
    catalog["zai"]["models"]["glm-filler"] = md_model(outputs=("image",))
    for key, models in providers.items():
        catalog[key]["models"].update(models)
    return catalog


def report_for(rows, litellm, modelsdev, min_compared=1):
    return build_report(
        rows,
        index_litellm({**LITELLM_FILLER, **litellm}),
        index_modelsdev(modelsdev),
        date=DATE,
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


def test_our_null_cache_rate_is_not_compared():
    rows = [row("gpt-a", "openai", cache_read=None)]
    litellm = {"gpt-a": ll_entry("openai", cache_read=5e-7)}
    assert report_for(rows, litellm, md_catalog())["flagged"] == []


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
    assert "• openai (30): gpt-new-0, gpt-new-1," in text
    assert "• xai (12): grok-new-0," in text
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
    assert f"<{check.PRICING_PAGES['deepseek']}|pricing page>" in text


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

    assert text.startswith(f"*Model pricing audit, {DATE}*: 1 price to check on 1 model")
    assert "`deepseek-d` input: $0.5 / $1 / $1" in text
    assert f"<{check.PRICING_PAGES['deepseek']}|pricing page>" in text


# --- the command line: main() with the network and Slack replaced ---------------


@pytest.fixture
def run(tmp_path, monkeypatch):
    """Run main() against sample data; returns (exit code, posted texts, report)."""
    monkeypatch.setenv("SLACK_WEBHOOK_URL", "https://hooks.example.test/T/B/x")
    posted = []
    monkeypatch.setattr(check, "post_to_slack", lambda _url, text: posted.append(text))

    def _run(rows, litellm, modelsdev, *extra):
        def fake_fetch(url):
            if isinstance(litellm, Exception):
                raise litellm
            return litellm if url == check.LITELLM_URL else modelsdev

        monkeypatch.setattr(check, "fetch_json", fake_fetch)
        prices = tmp_path / "prices.json"
        prices.write_text(json.dumps(rows))
        out = tmp_path / "report.json"
        argv = ["--post", "--prices", str(prices), "--json", str(out), *extra]
        code = check.main(argv)
        return code, posted, json.loads(out.read_text())

    return _run


def test_quiet_day_posts_a_heartbeat(run):
    rows = [row("gpt-a", "openai")]
    code, posted, report = run(
        rows, {"gpt-a": ll_entry("openai")}, md_catalog(), "--min-compared", "1"
    )

    assert code == 0
    assert report["status"] == "ok"
    [text] = posted
    assert text.startswith(f"*Model pricing audit, {report['date']}*: no price disagreements")


def test_format_change_exits_nonzero_and_posts_a_failure(run):
    rows = [row("gpt-a", "openai")]
    renamed = {"gpt-a": {**ll_entry("openai"), "input_cost_per_token": None}}
    code, posted, report = run(rows, renamed, md_catalog(), "--min-compared", "1")

    assert code == 1
    assert report["status"] == "failed"
    [text] = posted
    assert text.startswith(f"*Model pricing audit FAILED, {report['date']}*")
    assert "input_cost_per_token" in text
    assert "not an all-clear" in text


def test_too_few_rows_compared_exits_nonzero(run):
    rows = [row("gpt-a", "openai")]
    code, posted, _ = run(rows, {"gpt-a": ll_entry("openai")}, md_catalog())

    assert code == 1
    assert "below the floor of 80" in posted[0]


def test_unreachable_catalog_exits_nonzero(run):
    code, posted, _ = run([row("gpt-a", "openai")], URLError("offline"), md_catalog())

    assert code == 1
    assert "could not load the LiteLLM catalog" in posted[0]


def test_post_without_webhook_fails_before_fetching(tmp_path, monkeypatch, capsys):
    monkeypatch.delenv("SLACK_WEBHOOK_URL", raising=False)
    monkeypatch.setattr(check, "fetch_json", lambda url: pytest.fail("fetched"))

    assert check.main(["--post", "--prices", str(tmp_path / "unused.json")]) == 1
    assert "SLACK_WEBHOOK_URL" in capsys.readouterr().err


def test_slack_payload_is_a_json_text_message(monkeypatch):
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
    check.post_to_slack("https://hooks.example.test/T/B/x", "hello")

    [request] = sent
    assert request.get_method() == "POST"
    assert request.get_header("Content-type") == "application/json"
    assert json.loads(request.data) == {"text": "hello"}


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
