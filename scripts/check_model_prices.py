"""Check the standard model price file against two public price catalogs.

Compares each row of frontend/packages/core/src/standard-model-prices.json with
LiteLLM's model_prices_and_context_window.json and models.dev's api.json, and reports:

- flagged prices: an input, output or cacheRead rate that differs from ours by more
  than 3% in every catalog that lists the model under the same ID;
- missing models: text models a catalog prices for one of our providers that no row
  matches (exact model name first, then matchPattern, the order production uses),
  leaving out models either catalog marks as retired;
- rows with no exact-ID match in either catalog, which are not compared.

A flag means "check this row", not "this is the price". Confirm the rate on the
provider's pricing page, listed with each flag, before changing the price file.

  python3 scripts/check_model_prices.py                      # print the report
  python3 scripts/check_model_prices.py --json report.json   # also write it as JSON
  python3 scripts/check_model_prices.py --post               # post it to Slack
  python3 scripts/check_model_prices.py --payload msg.json   # write the Slack message

--post sends the report to the Slack incoming webhook in SLACK_WEBHOOK_URL as a Block
Kit message, problems first. It posts on every run, even when nothing is flagged, so a
missing message means the check did not run. --payload writes that message as JSON,
so it can be previewed or extended before it is posted. --litellm and --modelsdev take a URL or a local file, so a saved catalog
snapshot can be replayed.

Exit codes: 0 when a report was produced, with or without flags. 1 when a catalog
could not be loaded, a file's format changed, fewer than --min-compared rows could be
compared, or the Slack post failed. A failed run posts a failure alert when it can,
never an all-clear.

Standard library only, so it runs on any Python 3.11+ without installing anything.
"""

import argparse
import functools
import json
import os
import re
import sys
from datetime import UTC, datetime
from pathlib import Path
from urllib.error import URLError
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parent.parent
PRICE_FILE = ROOT / "frontend" / "packages" / "core" / "src" / "standard-model-prices.json"
LITELLM_URL = (
    "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json"
)
MODELSDEV_URL = "https://models.dev/api.json"
USER_AGENT = "traceroot-price-check"
TIMEOUT_SECONDS = 60

# The rates compared, by their name in our price file.
FIELDS = ("input", "output", "cacheRead")
TOLERANCE = 0.03
# Rows compared on a normal day are well above this; far fewer means a catalog's IDs or
# layout changed, which must fail the run rather than report a quiet day.
MIN_COMPARED = 80

# LiteLLM litellm_provider -> our provider. Other LiteLLM providers, such as vertex_ai-*,
# azure or API gateways, list the same models at their own prices, so they are skipped.
LITELLM_PROVIDERS = {
    "openai": "openai",
    "text-completion-openai": "openai",
    "anthropic": "anthropic",
    "gemini": "google",
    "xai": "xai",
    "deepseek": "deepseek",
    "zai": "zai",
    "moonshot": "moonshot",
    "typesafe": "typesafe",
}
# Our provider -> models.dev provider key. Skipped for the same reason: google-vertex,
# google-vertex-anthropic, zai-coding-plan and moonshotai-cn. models.dev has no typesafe.
MODELSDEV_PROVIDERS = {
    "openai": "openai",
    "anthropic": "anthropic",
    "google": "google",
    "xai": "xai",
    "deepseek": "deepseek",
    "zai": "zai",
    "moonshot": "moonshotai",
}
OUR_PROVIDERS = frozenset(LITELLM_PROVIDERS.values())
LITELLM_FIELDS = {
    "input": "input_cost_per_token",
    "output": "output_cost_per_token",
    "cacheRead": "cache_read_input_token_cost",
}
# models.dev prices are USD per million tokens.
MODELSDEV_FIELDS = {"input": "input", "output": "output", "cacheRead": "cache_read"}

# LiteLLM modes that bill text tokens. The rest (embedding, image, audio, rerank, ...)
# stay out of the missing-models list. realtime stays in: live models are realtime.
TEXT_MODES = frozenset({"chat", "completion", "responses", "realtime"})
# Names left out of the missing-models list even when a catalog files them as text:
# fine-tuned model prefixes, and embedding, image, audio and music models.
IGNORED_MODELS = re.compile(
    r"^ft:|embed|tts|whisper|transcribe|moderation|image|dall-e|imagen|audio|lyria",
    re.IGNORECASE,
)

# Where a person confirms a flagged rate.
PRICING_PAGES = {
    "openai": "https://developers.openai.com/api/docs/pricing",
    "anthropic": "https://platform.claude.com/docs/en/about-claude/pricing",
    "google": "https://aistudio.google.com/docs/pricing",
    "xai": "https://docs.x.ai/developers/models",
    # The HTML pricing page renders client-side; its Markdown copy has the rates.
    "deepseek": "https://api-docs.deepseek.com/quick_start/pricing.md",
    "zai": "https://docs.z.ai/guides/overview/pricing",
    "moonshot": "https://platform.kimi.ai/docs/pricing/chat",
}

# Rows in the Slack price table; the JSON report has every flag.
MAX_FLAGGED_LINES = 20
FIELD_LABELS = {"input": "input", "output": "output", "cacheRead": "cache read"}
# Missing models shown in small type under the main list: -latest aliases, dated
# snapshots, and realtime, live and search models, which follow a base model's price.
MINOR_MODELS = re.compile(
    r"-latest$|-\d{4}(-\d{2}-\d{2})?$|-\d{2}-\d{4}$|-\d{4}-\d+k$|realtime|-live|search",
    re.IGNORECASE,
)
# Slack Block Kit text limits.
HEADER_LIMIT = 150
SECTION_LIMIT = 3000
CONTEXT_LIMIT = 2000


class CheckError(Exception):
    """A condition that must fail the run loudly instead of reporting all clear."""


def _number(value):
    """A rate as a float, or None when it is absent or not a number."""
    if isinstance(value, bool) or not isinstance(value, int | float):
        return None
    return float(value)


def _day(value) -> datetime | None:
    """A catalog date such as 2026-11-08, or None when it is absent or unreadable."""
    if not isinstance(value, str):
        return None
    try:
        return datetime.fromisoformat(value[:10])
    except ValueError:
        return None


def _escape(text: str) -> str:
    """Escape the characters Slack reads as markup. Model IDs come from public
    catalogs, so an ID such as <!channel> must not become a mention."""
    return text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def validate_rows(data) -> list[dict]:
    """Check our price file's shape. Any missing key fails the run, as does a
    non-numeric input or output; cache rates may be null for models without them."""
    if not isinstance(data, list) or not data:
        raise CheckError("the price file is not a non-empty JSON list")
    for index, row in enumerate(data):
        if not isinstance(row, dict):
            raise CheckError(f"price file row {index} is not an object")
        name = row.get("id", f"#{index}")
        for key in ("id", "modelName", "matchPattern", "provider", "prices"):
            if key not in row:
                raise CheckError(f"price file row {name} has no {key}")
        if not isinstance(row["prices"], dict):
            raise CheckError(f"price file row {name} has no prices object")
        prices = row["prices"]
        for field in (*FIELDS, "cacheWrite"):
            if field not in prices:
                raise CheckError(f"price file row {name} has no prices.{field}")
            value = prices[field]
            required = field in ("input", "output")
            if _number(value) is None and (required or value is not None):
                raise CheckError(f"price file row {name} has a non-numeric prices.{field}")
    return data


def _require_fields(catalog: str, index: dict, source_fields: dict[str, str]) -> None:
    """Fail when a compared field is absent from every entry: a renamed field would
    otherwise turn into a day with nothing flagged."""
    if not index:
        raise CheckError(f"{catalog} lists no models for our providers")
    for field, source in source_fields.items():
        if all(entry["rates"][field] is None for entry in index.values()):
            raise CheckError(f"no {catalog} model has {source}")


def index_litellm(data) -> dict[tuple[str, str], dict]:
    """Map (our provider, model ID) to rates per token. Keys may carry a provider
    prefix, such as gemini/ or xai/, which is stripped to get the model ID."""
    if not isinstance(data, dict):
        raise CheckError("the LiteLLM catalog is not a JSON object")
    index: dict[tuple[str, str], dict] = {}
    for key, entry in data.items():
        if key == "sample_spec" or not isinstance(entry, dict):
            continue
        litellm_provider = entry.get("litellm_provider")
        provider = LITELLM_PROVIDERS.get(litellm_provider)
        if provider is None:
            continue
        model_id = key.removeprefix(f"{litellm_provider}/")
        if "/" in model_id:
            continue
        # A model can be listed both bare and prefixed; the bare key wins.
        if (provider, model_id) in index and key != model_id:
            continue
        index[(provider, model_id)] = {
            "rates": {field: _number(entry.get(src)) for field, src in LITELLM_FIELDS.items()},
            "text": entry.get("mode") in TEXT_MODES,
            "retired_from": _day(entry.get("deprecation_date")),
        }
    _require_fields("LiteLLM", index, LITELLM_FIELDS)
    return index


def index_modelsdev(data) -> dict[tuple[str, str], dict]:
    """Map (our provider, model ID) to rates per token, converted from per million."""
    if not isinstance(data, dict):
        raise CheckError("the models.dev catalog is not a JSON object")
    index: dict[tuple[str, str], dict] = {}
    for provider, key in MODELSDEV_PROVIDERS.items():
        listing = data.get(key)
        if not isinstance(listing, dict) or not isinstance(listing.get("models"), dict):
            raise CheckError(f"models.dev has no {key} provider")
        for model_id, model in listing["models"].items():
            if not isinstance(model, dict) or not isinstance(model.get("cost"), dict):
                continue
            rates = {}
            for field, src in MODELSDEV_FIELDS.items():
                value = _number(model["cost"].get(src))
                rates[field] = None if value is None else value / 1e6
            modalities = model.get("modalities")
            outputs = modalities.get("output") if isinstance(modalities, dict) else None
            index[(provider, model_id)] = {
                "rates": rates,
                "text": isinstance(outputs, list) and "text" in outputs,
                "retired_from": datetime.min if model.get("status") == "deprecated" else None,
            }
    _require_fields("models.dev", index, MODELSDEV_FIELDS)
    return index


@functools.cache
def _compile(pattern: str) -> re.Pattern[str] | None:
    try:
        return re.compile(pattern, re.IGNORECASE)
    except re.error:
        return None


def lookup(rows: list[dict], model_id: str) -> dict | None:
    """The row production would price model_id with: an exact modelName match first,
    then the first matchPattern hit in file order. A pattern that will not compile is
    skipped, as production skips it."""
    for row in rows:
        if row["modelName"] == model_id:
            return row
    for row in rows:
        pattern = _compile(row["matchPattern"])
        if pattern is not None and pattern.search(model_id):
            return row
    return None


def differs(ours: float, theirs: float, tolerance: float = TOLERANCE) -> bool:
    """True when two rates differ by more than tolerance, relative to the larger."""
    return abs(ours - theirs) > tolerance * max(abs(ours), abs(theirs))


def find_missing(rows: list[dict], catalogs: dict[str, dict], today: datetime) -> list[dict]:
    """Text models a catalog prices for one of our providers that no row matches.

    A model either catalog marks as retired is left out: LiteLLM's deprecation_date on
    or before today, or models.dev's status "deprecated".
    """
    seen: dict[tuple[str, str], list[str]] = {}
    retired: set[tuple[str, str]] = set()
    for name, index in catalogs.items():
        for key, entry in index.items():
            if entry["retired_from"] is not None and entry["retired_from"] <= today:
                retired.add(key)
                continue
            if not entry["text"] or IGNORED_MODELS.search(key[1]):
                continue
            if entry["rates"]["input"] is None and entry["rates"]["output"] is None:
                continue
            seen.setdefault(key, []).append(name)
    return [
        {"model": model_id, "provider": provider, "in": sorted(names)}
        for (provider, model_id), names in sorted(seen.items())
        if (provider, model_id) not in retired and lookup(rows, model_id) is None
    ]


def build_report(
    rows: list[dict],
    litellm: dict,
    modelsdev: dict,
    *,
    date: str,
    min_compared: int = MIN_COMPARED,
) -> dict:
    """Compare every row by exact model ID. A rate is flagged only when every catalog
    that lists the model and has that rate disagrees with ours."""
    catalogs = {"litellm": litellm, "modelsdev": modelsdev}
    flagged: list[dict] = []
    no_match: list[str] = []
    unmapped: set[str] = set()
    compared = 0
    for row in rows:
        provider, model = row["provider"], row["modelName"]
        if provider not in OUR_PROVIDERS:
            unmapped.add(provider)
            no_match.append(model)
            continue
        found = {
            name: index[(provider, model)]["rates"]
            for name, index in catalogs.items()
            if (provider, model) in index
        }
        if not found:
            no_match.append(model)
            continue
        compared += 1
        for field in FIELDS:
            ours = _number(row["prices"][field])
            if ours is None:
                continue
            theirs = {
                name: rates[field] for name, rates in found.items() if rates[field] is not None
            }
            if theirs and all(differs(ours, value) for value in theirs.values()):
                flagged.append(
                    {
                        "model": model,
                        "provider": provider,
                        "field": field,
                        "ours": ours,
                        "litellm": theirs.get("litellm"),
                        "modelsdev": theirs.get("modelsdev"),
                        "pricing_page": PRICING_PAGES.get(provider),
                    }
                )
    if compared < min_compared:
        raise CheckError(
            f"only {compared} of {len(rows)} rows matched a catalog, below the floor of "
            f"{min_compared}; a catalog's model IDs or format may have changed"
        )
    bad_patterns = sorted(row["id"] for row in rows if _compile(row["matchPattern"]) is None)
    return {
        "date": date,
        "status": "ok",
        "total": len(rows),
        "compared": compared,
        "flagged": flagged,
        "missing": find_missing(rows, catalogs, datetime.fromisoformat(date)),
        "no_match": no_match,
        "unmapped_providers": sorted(unmapped),
        "bad_patterns": bad_patterns,
    }


def _plural(count: int, word: str) -> str:
    return f"{count} {word}" if count == 1 else f"{count} {word}s"


def _amount(per_token: float) -> str:
    """A per-token rate as USD per million tokens, with at least two decimals."""
    text = f"{per_token * 1e6:.4g}"
    if "e" in text:
        text = f"{per_token * 1e6:.8f}".rstrip("0")
    whole, _, fraction = text.partition(".")
    return f"{whole}.{fraction.ljust(2, '0')}"


def _catalog_amount(item: dict) -> str:
    """The catalogs' rate, or the range they span when they disagree with each other."""
    values = sorted(item[name] for name in ("litellm", "modelsdev") if item[name] is not None)
    low, high = _amount(values[0]), _amount(values[-1])
    return low if low == high else f"{low}-{high}"


def _price_table(flagged: list[dict]) -> list[str]:
    """Flagged rates as an aligned code block, one row per rate, grouped by model."""
    cells = []
    previous = None
    for item in flagged[:MAX_FLAGGED_LINES]:
        model = item["model"] if item["model"] != previous else ""
        previous = item["model"]
        cells.append(
            (model, FIELD_LABELS[item["field"]], _amount(item["ours"]), _catalog_amount(item))
        )
    widths = [max(len(cell[column]) for cell in cells) for column in range(3)]
    rows = [
        f"{model:<{widths[0]}}  {field:<{widths[1]}}  {ours:<{widths[2]}}  → {theirs}"
        for model, field, ours, theirs in cells
    ]
    # Pad first, then escape: Slack shows the escaped text unescaped, so columns stay aligned.
    return ["```", *(_escape(line) for line in rows), "```"]


def _status(report: dict) -> str:
    """One line on what needs attention, e.g. "3 models with prices to check"."""
    flagged_models = dict.fromkeys(item["model"] for item in report["flagged"])
    status = (
        f"{_plural(len(flagged_models), 'model')} with prices to check"
        if flagged_models
        else "prices match the catalogs"
    )
    if report["missing"]:
        status += f", {_plural(len(report['missing']), 'model')} not priced"
    return status


def _split_missing(missing: list[dict]) -> tuple[dict, dict]:
    """Missing model names by provider: (main list, aliases/snapshots/realtime/search)."""
    main: dict[str, list[str]] = {}
    minor: dict[str, list[str]] = {}
    for item in missing:
        target = minor if MINOR_MODELS.search(item["model"]) else main
        target.setdefault(item["provider"], []).append(item["model"])
    return main, minor


def _footer(report: dict) -> str:
    footer = f"Compared {report['compared']} of {report['total']} rows with LiteLLM and models.dev"
    if report["no_match"]:
        footer += f" · {len(report['no_match'])} are in neither catalog under the same ID"
    if report["unmapped_providers"]:
        footer += f" · no catalog for {', '.join(report['unmapped_providers'])}"
    return footer


def _clip(text: str, limit: int) -> str:
    return text if len(text) <= limit else text[: limit - 1] + "…"


def _count(by_provider: dict[str, list[str]]) -> int:
    return sum(len(models) for models in by_provider.values())


def _names(by_provider: dict[str, list[str]], *, bullet: str, separator: str) -> str:
    """Model names grouped by provider, e.g. "• *openai* (2): gpt-a, gpt-b"."""
    return separator.join(
        f"{bullet}*{_escape(provider)}* ({len(models)}): {', '.join(_escape(m) for m in models)}"
        for provider, models in sorted(by_provider.items())
    )


def format_report(report: dict) -> str:
    """The report as text for the terminal: what to fix first, then context."""
    flagged = report["flagged"]
    lines = [f"*Model pricing audit, {report['date']}*: {_status(report)}"]

    if flagged:
        lines += ["", "*Prices to check* (USD per 1M tokens, ours → catalogs)"]
        lines += _price_table(flagged)
        if len(flagged) > MAX_FLAGGED_LINES:
            lines.append(f"…and {len(flagged) - MAX_FLAGGED_LINES} more in the JSON report")
        pages = dict.fromkeys(
            (item["provider"], item["pricing_page"]) for item in flagged if item["pricing_page"]
        )
        if pages:
            links = " · ".join(f"<{url}|{_escape(provider)}>" for provider, url in pages)
            lines.append(f"Pricing pages: {links}")

    if report["bad_patterns"]:
        bad = ", ".join(_escape(p) for p in report["bad_patterns"])
        lines += ["", f"*matchPattern does not compile*: {bad}"]

    # Every missing name appears, one line per provider, so none is cut from the report.
    main, minor = _split_missing(report["missing"])
    if main:
        lines += ["", f"*Not priced* ({_count(main)})", _names(main, bullet="• ", separator="\n")]
    if minor:
        heading = f"*Also not priced: aliases, snapshots, realtime and search* ({_count(minor)})"
        lines += ["", heading, _names(minor, bullet="• ", separator="\n")]

    lines += ["", f"_{_escape(_footer(report))}._"]
    return "\n".join(lines)


def _mrkdwn(text: str) -> dict:
    return {"type": "mrkdwn", "text": text}


def _cell(text: str, *, url: str | None = None, bold: bool = False) -> dict:
    """A table cell: rich text, so it can be bold or a link, with no mrkdwn parsing."""
    element = {"type": "link", "url": url, "text": text} if url else {"type": "text", "text": text}
    if bold:
        element["style"] = {"bold": True}
    return {"type": "rich_text", "elements": [{"type": "rich_text_section", "elements": [element]}]}


def _price_table_block(flagged: list[dict]) -> dict:
    """Flagged rates as a table, one row per rate; the model name links to its pricing page."""
    rows = [[_cell(title, bold=True) for title in ("Model", "Rate", "Ours", "Catalogs")]]
    previous = None
    for item in flagged[:MAX_FLAGGED_LINES]:
        first = item["model"] != previous
        previous = item["model"]
        model = _cell(item["model"], url=item["pricing_page"]) if first else _cell(" ")
        rows.append(
            [
                model,
                _cell(FIELD_LABELS[item["field"]]),
                _cell(_amount(item["ours"])),
                _cell(_catalog_amount(item)),
            ]
        )
    return {
        "type": "table",
        "block_id": "prices",
        "column_settings": [
            {"is_wrapped": True},
            {"align": "left"},
            {"align": "right"},
            {"align": "right"},
        ],
        "rows": rows,
    }


def build_payload(report: dict) -> dict:
    """The Slack message (Block Kit) for a completed run: what to fix first, then context."""
    flagged = report["flagged"]
    main, minor = _split_missing(report["missing"])
    flagged_models = dict.fromkeys(item["model"] for item in flagged)
    status = [
        f":red_circle: *{_plural(len(flagged_models), 'model')} with prices to check*"
        if flagged
        else ":large_green_circle: *Prices match the catalogs*"
    ]
    if report["missing"]:
        status.append(
            f":large_yellow_circle: *{_plural(len(report['missing']), 'model')} not priced*"
        )
    title = f"Model pricing audit · {report['date']}"
    blocks: list[dict] = [
        {"type": "header", "text": {"type": "plain_text", "text": _clip(title, HEADER_LIMIT)}},
        {"type": "section", "text": _mrkdwn("     ".join(status))},
    ]
    if flagged:
        heading = "*Prices to check* · USD per 1M tokens, ours vs. the catalogs"
        blocks += [{"type": "section", "text": _mrkdwn(heading)}, _price_table_block(flagged)]
        if len(flagged) > MAX_FLAGGED_LINES:
            more = f"…and {len(flagged) - MAX_FLAGGED_LINES} more rates in the JSON report"
            blocks.append(
                {"type": "context", "block_id": "prices_more", "elements": [_mrkdwn(more)]}
            )
    if report["bad_patterns"]:
        bad = ", ".join(_escape(p) for p in report["bad_patterns"])
        text = f"*matchPattern does not compile*, so these rows match by exact name only: {bad}"
        blocks.append({"type": "section", "text": _mrkdwn(_clip(text, SECTION_LIMIT))})
    if main or minor:
        blocks.append({"type": "divider"})
    if main:
        heading = f"*Not priced* · {_count(main)} models a catalog prices that no row matches"
        body = _names(main, bullet="• ", separator="\n")
        blocks.append(
            {"type": "section", "text": _mrkdwn(_clip(f"{heading}\n{body}", SECTION_LIMIT))}
        )
    if minor:
        heading = f"*Also not priced* ({_count(minor)}): aliases, snapshots, realtime and search"
        body = _names(minor, bullet="", separator=" · ")
        text = _clip(f"{heading} · {body}", CONTEXT_LIMIT)
        blocks.append({"type": "context", "elements": [_mrkdwn(text)]})
    footer = _clip(_escape(_footer(report)), CONTEXT_LIMIT)
    blocks.append({"type": "context", "elements": [_mrkdwn(footer)]})
    return {"text": f"Model pricing audit, {report['date']}: {_status(report)}", "blocks": blocks}


def format_failure(date: str, reason: str) -> str:
    return (
        f"*Model pricing audit FAILED, {date}*: {_escape(reason)}. "
        "Nothing was compared, so this is not an all-clear."
    )


def failure_payload(date: str, reason: str) -> dict:
    text = f":warning: {_escape(reason)}. Nothing was compared, so this is not an all-clear."
    title = f"Model pricing audit FAILED · {date}"
    return {
        "text": f"Model pricing audit FAILED, {date}: {reason}",
        "blocks": [
            {"type": "header", "text": {"type": "plain_text", "text": _clip(title, HEADER_LIMIT)}},
            {"type": "section", "text": _mrkdwn(_clip(text, SECTION_LIMIT))},
        ],
    }


def fetch_json(url: str):
    request = Request(url, headers={"User-Agent": USER_AGENT})
    with urlopen(request, timeout=TIMEOUT_SECONDS) as response:
        return json.load(response)


def load_source(source: str, label: str):
    """Load a catalog from a URL or a local file. Any failure fails the run."""
    try:
        if source.startswith(("https://", "http://")):
            return fetch_json(source)
        return json.loads(Path(source).read_text())
    except (URLError, OSError, ValueError) as exc:
        raise CheckError(f"could not load the {label} catalog ({type(exc).__name__})") from exc


def post_to_slack(webhook: str, payload: dict) -> None:
    body = json.dumps(payload).encode()
    request = Request(
        webhook,
        data=body,
        headers={"Content-Type": "application/json", "User-Agent": USER_AGENT},
        method="POST",
    )
    with urlopen(request, timeout=TIMEOUT_SECONDS) as response:
        response.read()


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument(
        "--post", action="store_true", help="post the report to the webhook in SLACK_WEBHOOK_URL"
    )
    parser.add_argument("--json", type=Path, metavar="PATH", help="also write the report as JSON")
    parser.add_argument(
        "--payload", type=Path, metavar="PATH", help="also write the Slack message as JSON"
    )
    parser.add_argument("--prices", type=Path, default=PRICE_FILE, help="our price file")
    parser.add_argument("--litellm", default=LITELLM_URL, metavar="URL_OR_PATH")
    parser.add_argument("--modelsdev", default=MODELSDEV_URL, metavar="URL_OR_PATH")
    parser.add_argument(
        "--min-compared",
        type=int,
        default=MIN_COMPARED,
        help=f"fail when fewer rows than this are compared (default {MIN_COMPARED})",
    )
    args = parser.parse_args(argv)

    webhook = os.environ.get("SLACK_WEBHOOK_URL", "").strip()
    if args.post and not webhook:
        print("--post needs SLACK_WEBHOOK_URL set to a Slack incoming webhook URL", file=sys.stderr)
        return 1

    date = datetime.now(UTC).date().isoformat()
    try:
        rows = validate_rows(json.loads(args.prices.read_text()))
        litellm = index_litellm(load_source(args.litellm, "LiteLLM"))
        modelsdev = index_modelsdev(load_source(args.modelsdev, "models.dev"))
        report = build_report(rows, litellm, modelsdev, date=date, min_compared=args.min_compared)
        text, payload, status = format_report(report), build_payload(report), 0
    except Exception as exc:  # Every failure must alert; none may read as all clear.
        reason = str(exc) if isinstance(exc, CheckError) else f"{type(exc).__name__}: {exc}"
        report = {"date": date, "status": "failed", "error": reason}
        text, payload, status = format_failure(date, reason), failure_payload(date, reason), 1

    if args.json:
        args.json.write_text(json.dumps(report, indent=2) + "\n")
    if args.payload:
        args.payload.write_text(json.dumps(payload, indent=2, ensure_ascii=False) + "\n")
    print(text)
    if args.post:
        try:
            post_to_slack(webhook, payload)
        except (URLError, OSError) as exc:
            # Never echo the webhook URL: report only the error type and status.
            detail = getattr(exc, "code", None) or type(exc).__name__
            print(f"Slack post failed ({detail})", file=sys.stderr)
            return 1
    return status


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
