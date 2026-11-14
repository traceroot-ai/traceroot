"""Small inline samples of the price file and both catalogs, and helpers that build
reports from them or run main() on them, shared by the price check tests. None reads the
real price file or the network."""

import json

from scripts.model_prices import catalogs, cli, tracking
from scripts.model_prices.catalogs import (
    LITELLM_URL,
    MODELSDEV_URL,
    index_hosted,
    index_litellm,
    index_modelsdev,
)
from scripts.model_prices.checks import build_report
from scripts.model_prices.tracking import PRICE_PATH, track

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


def _block_text(block):
    if block["type"] == "context":
        return " ".join(element["text"] for element in block["elements"])
    return block.get("text", {}).get("text", "")


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
        {"number": 11, "url": "https://github.test/pull/11", "report": evaluate(fix_input)},
        {"number": 12, "url": "https://github.test/pull/12", "report": evaluate(adds_new)},
        {"number": 13, "url": "https://github.test/pull/13", "error": "could not read it"},
    ]
    report = evaluate(rows)
    track(report, prs)
    return report


def _track_one_pr(rows, litellm, pr_rows):
    """The report for rows, with one open PR, #7, whose price file is pr_rows."""
    catalogs = (index_litellm({**LITELLM_FILLER, **litellm}), index_modelsdev(md_catalog()))

    def evaluate(rows):
        return build_report(rows, *catalogs, date=DATE, min_compared=0)

    report = evaluate(rows)
    track(report, [{"number": 7, "report": evaluate(pr_rows)}])
    return report


def runner(tmp_path, monkeypatch):
    """Run main() against sample data; returns (exit code, posted payloads, report). With
    heads, GitHub has an open pricing PR for each entry, branched from rows: its number,
    and the price file at its head or the error reading the PR raises. With
    write_json=False, the run writes no JSON report and the report returned is None."""
    monkeypatch.setenv("SLACK_WEBHOOK_URL", "https://hooks.example.test/T/B/x")
    posted = []
    monkeypatch.setattr(cli, "post_to_slack", lambda _url, payload: posted.append(payload))

    def _run(rows, litellm, modelsdev, *extra, heads=None, write_json=True):
        if isinstance(litellm, dict):
            # Only the cache write rates, so a test can still remove any other field.
            filler = {"litellm_provider": "openai", "mode": "embedding", **CACHE_WRITE_RATES}
            litellm = {"cache-write-filler": filler, **litellm}

        def fake_fetch(url, max_bytes=None):
            if isinstance(litellm, Exception):
                raise litellm
            if url in (LITELLM_URL, MODELSDEV_URL):
                return litellm if url == LITELLM_URL else modelsdev
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
            return {"merge_base_commit": {"sha": "base"}, "files": [{"filename": PRICE_PATH}]}

        monkeypatch.setattr(catalogs, "fetch_json", fake_fetch)
        monkeypatch.setattr(tracking, "fetch_json", fake_fetch)
        if heads is not None:
            monkeypatch.setattr(tracking, "_github", fake_github)
        prices = tmp_path / "prices.json"
        prices.write_text(json.dumps(rows))
        out = tmp_path / "report.json"
        argv = ["--post", "--prices", str(prices), *extra]
        code = cli.main([*argv, "--json", str(out)] if write_json else argv)
        return code, posted, json.loads(out.read_text()) if write_json else None

    return _run
