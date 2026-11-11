"""Check the standard model price file against two public price catalogs.

Compares each row of frontend/packages/core/src/standard-model-prices.json with
LiteLLM's model_prices_and_context_window.json and models.dev's api.json, and reports:

- flagged prices: an input, output, cache read or cache write rate that differs from
  ours by more than 3% in every catalog that lists the model under the same ID. A
  catalog model that a row prices through its matchPattern, such as a newer version an
  older row's pattern also matches, is compared with that row's rates;
- missing models: text models a catalog prices for one of our providers that no row
  matches (exact model name first, then matchPattern, the order production uses),
  leaving out models either catalog marks as retired;
- model IDs a row should price but does not: the IDs a model has on Bedrock, Vertex AI
  and OpenRouter, and the [1m] ID of a model with a 1M-token context window. One that
  matches no row records no cost; one that another row matches gets that row's price;
- overlapping patterns: an ID that two rows' patterns match at different prices. The
  worker tries patterns in modelName order and the UI in database order, so the two
  can price the same span differently;
- row problems: a pattern that does not compile, uses syntax the UI's JavaScript regex
  rejects or reads differently, or misses its own modelName; a modelName listed twice;
  a rate below zero or above $1,000 per million tokens; a cache read rate above the
  input rate;
- long-context rates: models a catalog charges more for above a prompt size, which the
  price file has no field for;
- rows with no exact-ID match in either catalog, which are not compared.

With --track, each finding also names the open pull requests that would clear it: the
script applies each pricing PR's row changes to the current price file and checks the
result again. It also lists any problem a PR would add.

A flag means "check this row", not "this is the price". Confirm the rate on the
provider's pricing page, listed with each flag, before changing the price file.

  python3 scripts/check_model_prices.py                      # print the report
  python3 scripts/check_model_prices.py --json report.json   # also write it as JSON
  python3 scripts/check_model_prices.py --post               # post it to Slack
  python3 scripts/check_model_prices.py --payload msg.json   # write the Slack message
  python3 scripts/check_model_prices.py --track              # name the PRs that fix each
  python3 scripts/check_model_prices.py --html report.html   # write the full report page
  python3 scripts/check_model_prices.py --baseline before.json  # check an edit to the file

--post sends a short Block Kit message to the Slack incoming webhook in
SLACK_WEBHOOK_URL: what needs a fix and has no open PR, then what open PRs already fix.
It posts on every run, even when nothing is flagged, so a missing message means the
check did not run. --payload writes that message as JSON, so it can be previewed or
extended before it is posted. --html writes every finding as a web page, and
--report-url links the message to where that page is published. --litellm and --modelsdev take
a URL or a local file, so a saved catalog snapshot can be replayed. --track reads
GitHub, with GITHUB_TOKEN or GH_TOKEN when set; if GitHub can't be read, the report
says so and the run still succeeds.

--baseline checks an edit to the price file before it goes into a pull request. Save a
report with --json before the edit, edit the file, then run again with --baseline
pointing at that report: the output lists the findings the edit fixes and any it adds.
Pass the same saved --litellm and --modelsdev files to both runs, so only the price
file differs between them.

Exit codes: 0 when a report was produced, with or without flags. 1 when a catalog
could not be loaded, a file's format changed, fewer than --min-compared rows could be
compared, the --baseline report could not be read, or the Slack post failed. 2 with
--baseline when the price file adds a finding the baseline report does not have. A
failed run posts a failure alert when it can, never an all-clear.

Standard library only, so it runs on any Python 3.11+ without installing anything.
"""

import argparse
import functools
import html
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

# The rates compared, by their name in our price file. Every row has the first four;
# cacheWrite1h only appears on rows with a separate 1-hour cache write rate.
FIELDS = ("input", "output", "cacheRead", "cacheWrite", "cacheWrite1h")
REQUIRED_FIELDS = ("input", "output", "cacheRead", "cacheWrite")
TOLERANCE = 0.03
# Per-token rates outside this range are a unit slip, such as a per-million price.
MAX_RATE = 1e-3
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
    "cacheWrite": "cache_creation_input_token_cost",
    "cacheWrite1h": "cache_creation_input_token_cost_above_1hr",
}
# models.dev prices are USD per million tokens. It has no 1-hour cache write rate.
MODELSDEV_FIELDS = {
    "input": "input",
    "output": "output",
    "cacheRead": "cache_read",
    "cacheWrite": "cache_write",
}
# LiteLLM's standard long-context rates, e.g. input_cost_per_token_above_200k_tokens.
# Batch, flex and priority variants have a suffix and are left out.
LITELLM_LONG_CONTEXT = re.compile(r"^(?:input|output)_cost_per_token_above_(\d+)k_tokens$")
# A model with at least this context window is also called with a [1m] suffix.
ONE_MILLION = 1_000_000

# Hosts that serve our providers' models under their own IDs, such as
# us.anthropic.claude-sonnet-5-5 on Bedrock or anthropic/claude-sonnet-5.5 on
# OpenRouter. A span from one of them carries that ID, so the model's row must match it.
# Only the IDs are checked: hosts set their own prices.
LITELLM_HOSTS = {
    "bedrock": "Bedrock",
    "bedrock_converse": "Bedrock",
    "vertex_ai-anthropic_models": "Vertex AI",
}
MODELSDEV_HOSTS = {"amazon-bedrock": "Bedrock", "openrouter": "OpenRouter"}
# What a host adds around a model's own ID: a region, a vendor, a version or a date.
HOST_PREFIX = re.compile(
    r"^(?:(?:us|us-gov|eu|apac|au|jp|in|ca|global)\.)?"
    r"(?:anthropic|openai|xai|x-ai|google|deepseek|moonshotai|zai|z-ai)[./]"
)
HOST_SUFFIX = re.compile(r"(?:-\d{8})?(?:-v\d+(?::\d+)?)?(?:@\d{8})?$")

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

# Regex syntax Python accepts that JavaScript's RegExp rejects or reads differently, so
# the UI drops the pattern or matches other IDs: Python's named groups, \A and \Z,
# comments, atomic groups and possessive quantifiers. The leading (?i) is fine; the UI
# strips it.
JS_INCOMPATIBLE = re.compile(r"\(\?P[<=>]|\\[AZ]|\(\?#|\(\?>|[*+?}]\+")

# --track: open pull requests that change the price file.
GITHUB_REPO = "traceroot-ai/traceroot"
GITHUB_API = "https://api.github.com"
GITHUB_RAW = "https://raw.githubusercontent.com"
PRICE_PATH = "frontend/packages/core/src/standard-model-prices.json"
MAX_PR_PAGES = 10
# A PR is checked when its title or body mentions pricing or a model in the report.
PRICING_WORDS = re.compile(r"pric", re.IGNORECASE)
CLOSES_ISSUE = re.compile(r"\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)", re.IGNORECASE)

# Rows in the Slack price table; the JSON report has every flag.
MAX_FLAGGED_LINES = 20
FIELD_LABELS = {
    "input": "input",
    "output": "output",
    "cacheRead": "cache read",
    "cacheWrite": "cache write",
    "cacheWrite1h": "cache write 1h",
}
# Missing models shown in small type under the main list: -latest aliases, dated
# snapshots, and realtime, live and search models, which follow a base model's price.
MINOR_MODELS = re.compile(
    r"-latest$|-\d{4}(-\d{2}-\d{2})?$|-\d{2}-\d{4}$|-\d{4}-\d+k$|realtime|-live|search",
    re.IGNORECASE,
)
# What the model-ID section lists, for both the terminal and Slack.
ID_HEADING = (
    "IDs a model has on Bedrock, Vertex AI or OpenRouter, or with [1m], that its row's "
    "matchPattern misses, so their spans record no cost"
)
# Provider names as people write them, for counts in the Slack message.
PROVIDER_NAMES = {
    "openai": "OpenAI",
    "anthropic": "Anthropic",
    "google": "Google",
    "xai": "xAI",
    "deepseek": "DeepSeek",
    "zai": "Z.ai",
    "moonshot": "Moonshot",
    "typesafe": "TypeSafe",
}
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
    non-numeric input or output; cache rates may be null for models without them, and
    cacheWrite1h may be left out."""
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
        for field in FIELDS:
            if field not in prices:
                if field in REQUIRED_FIELDS:
                    raise CheckError(f"price file row {name} has no prices.{field}")
                continue
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
        tiers = [int(m[1]) * 1000 for m in map(LITELLM_LONG_CONTEXT.match, entry) if m]
        index[(provider, model_id)] = {
            "rates": {field: _number(entry.get(src)) for field, src in LITELLM_FIELDS.items()},
            "text": entry.get("mode") in TEXT_MODES,
            "retired_from": _day(entry.get("deprecation_date")),
            "context": _number(entry.get("max_input_tokens")),
            "long_context": min(tiers, default=None),
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
            rates: dict[str, float | None] = dict.fromkeys(FIELDS)
            for field, src in MODELSDEV_FIELDS.items():
                value = _number(model["cost"].get(src))
                rates[field] = None if value is None else value / 1e6
            limit = model.get("limit")
            index[(provider, model_id)] = {
                "rates": rates,
                "text": _outputs_text(model),
                "retired_from": _retired(model),
                "context": _number(limit.get("context")) if isinstance(limit, dict) else None,
                # e.g. "context_over_200k": the rates above a 200K-token prompt.
                "long_context": 200_000 if "context_over_200k" in model["cost"] else None,
            }
    _require_fields("models.dev", index, MODELSDEV_FIELDS)
    return index


def _outputs_text(model: dict) -> bool:
    modalities = model.get("modalities")
    outputs = modalities.get("output") if isinstance(modalities, dict) else None
    return isinstance(outputs, list) and "text" in outputs


def _retired(model: dict) -> datetime | None:
    return datetime.min if model.get("status") == "deprecated" else None


def index_hosted(litellm, modelsdev) -> dict[str, dict]:
    """The IDs other hosts serve our providers' models under, such as Bedrock's
    us.anthropic.claude-sonnet-5-5, each with its host and whether it is a live text
    model. Vertex AI's @default placeholder and OpenRouter's :free style variants are
    not IDs a span carries, so they are left out."""
    hosted: dict[str, dict] = {}
    for key, entry in litellm.items() if isinstance(litellm, dict) else ():
        host = LITELLM_HOSTS.get(entry.get("litellm_provider")) if isinstance(entry, dict) else None
        if host is None:
            continue
        # Keys may carry routing segments, as in bedrock/us-gov-west-1/<model ID>.
        model_id = key.rsplit("/", 1)[-1]
        if not model_id.endswith("@default"):
            hosted[model_id] = {
                "host": host,
                "text": entry.get("mode") in TEXT_MODES,
                "retired_from": _day(entry.get("deprecation_date")),
            }
    for key, host in MODELSDEV_HOSTS.items():
        listing = modelsdev.get(key) if isinstance(modelsdev, dict) else None
        models = listing.get("models") if isinstance(listing, dict) else None
        for model_id, model in models.items() if isinstance(models, dict) else ():
            # OpenRouter's ~vendor/model-latest aliases and :free or :thinking variants.
            variant = model_id.startswith("~") or (host == "OpenRouter" and ":" in model_id)
            if isinstance(model, dict) and not variant:
                hosted.setdefault(
                    model_id,
                    {"host": host, "text": _outputs_text(model), "retired_from": _retired(model)},
                )
    return hosted


@functools.cache
def _compile(pattern: str) -> re.Pattern[str] | None:
    try:
        return re.compile(pattern, re.IGNORECASE)
    except re.error:
        return None


def _matches(row: dict, model_id: str) -> bool:
    pattern = _compile(row["matchPattern"])
    return pattern is not None and pattern.search(model_id) is not None


def _by_name(rows: list[dict]) -> list[dict]:
    return sorted(rows, key=lambda row: row["modelName"])


def lookup(rows: list[dict], model_id: str) -> dict | None:
    """The row the worker prices model_id with: an exact modelName match first, then
    the first matchPattern hit in modelName order, the order it reads rows in. A
    pattern that will not compile is skipped, as production skips it. The UI reads rows
    in database order instead, so an ID two patterns match is reported as an overlap."""
    for row in rows:
        if row["modelName"] == model_id:
            return row
    return next((row for row in _by_name(rows) if _matches(row, model_id)), None)


def differs(ours: float, theirs: float, tolerance: float = TOLERANCE) -> bool:
    """True when two rates differ by more than tolerance, relative to the larger."""
    return abs(ours - theirs) > tolerance * max(abs(ours), abs(theirs))


def _flag_rates(
    row: dict, provider: str, model: str, found: dict[str, dict], *, priced_as: str | None
) -> list[dict]:
    """A flag for each of the row's rates that every catalog listing model disagrees with."""
    flags = []
    for field in FIELDS:
        ours = _number(row["prices"].get(field))
        if ours is None:
            continue
        theirs = {name: rates[field] for name, rates in found.items() if rates[field] is not None}
        if theirs and all(differs(ours, value) for value in theirs.values()):
            flags.append(
                {
                    "model": model,
                    "provider": provider,
                    "field": field,
                    "ours": ours,
                    "litellm": theirs.get("litellm"),
                    "modelsdev": theirs.get("modelsdev"),
                    "pricing_page": PRICING_PAGES.get(provider),
                    "priced_as": priced_as,
                }
            )
    return flags


def _live_text_models(
    catalogs: dict[str, dict], today: datetime
) -> dict[tuple[str, str], dict[str, dict]]:
    """Each live text model's rates by catalog. A model either catalog marks as retired
    is left out: LiteLLM's deprecation_date on or before today, or models.dev's status
    "deprecated". So are fine-tuned, embedding, image, audio and music models."""
    found: dict[tuple[str, str], dict[str, dict]] = {}
    retired: set[tuple[str, str]] = set()
    for name, index in catalogs.items():
        for key, entry in index.items():
            if entry["retired_from"] is not None and entry["retired_from"] <= today:
                retired.add(key)
            elif entry["text"] and not IGNORED_MODELS.search(key[1]):
                found.setdefault(key, {})[name] = entry["rates"]
    return {key: rates for key, rates in sorted(found.items()) if key not in retired}


def find_shadowed(rows: list[dict], catalogs: dict[str, dict], today: datetime) -> list[dict]:
    """Flags for catalog models that production prices through another row's
    matchPattern, compared with that row's rates. An older row's pattern can also match
    a newer version at a different price, which a by-name comparison never sees."""
    flags = []
    for (provider, model), found in _live_text_models(catalogs, today).items():
        row = lookup(rows, model)
        if row is not None and row["modelName"].lower() != model.lower():
            flags += _flag_rates(row, provider, model, found, priced_as=row["modelName"])
    return flags


def find_missing(rows: list[dict], catalogs: dict[str, dict], today: datetime) -> list[dict]:
    """Live text models a catalog prices for one of our providers that no row matches."""
    missing = []
    for (provider, model_id), found in _live_text_models(catalogs, today).items():
        names = sorted(
            name
            for name, rates in found.items()
            if rates["input"] is not None or rates["output"] is not None
        )
        if names and lookup(rows, model_id) is None:
            missing.append({"model": model_id, "provider": provider, "in": names})
    return missing


def _family(model_id: str) -> str:
    """A model's name with version dots as hyphens: OpenRouter's claude-sonnet-5.5 is
    our claude-sonnet-5-5."""
    return model_id.lower().replace(".", "-")


def _variant_ids(
    rows: list[dict], catalogs: dict[str, dict], hosted: dict[str, dict], today: datetime
) -> list[tuple[str, str, dict]]:
    """(ID, where it comes from, the row it belongs to) for each ID a row should price
    besides its own name: the model's live IDs on other hosts, and its [1m] ID when a
    catalog gives it a context window of 1M tokens or more."""
    by_family = {_family(row["modelName"]): row for row in rows}
    variants = []
    for model_id, entry in sorted(hosted.items()):
        retired = entry["retired_from"] is not None and entry["retired_from"] <= today
        if retired or not entry["text"] or IGNORED_MODELS.search(model_id):
            continue
        base = HOST_SUFFIX.sub("", HOST_PREFIX.sub("", model_id.rsplit("/", 1)[-1]))
        row = by_family.get(_family(base))
        if row is not None and model_id != row["modelName"]:
            variants.append((model_id, entry["host"], row))
    for row in rows:
        contexts = [
            index[(row["provider"], row["modelName"])]["context"] or 0
            for index in catalogs.values()
            if (row["provider"], row["modelName"]) in index
        ]
        if row["provider"] == "anthropic" and max(contexts, default=0) >= ONE_MILLION:
            variants.append((f"{row['modelName']}[1m]", "1M context", row))
    return variants


def find_unpriced_ids(
    rows: list[dict], catalogs: dict[str, dict], hosted: dict[str, dict], today: datetime
) -> list[dict]:
    """IDs a row should price that no row matches, so their spans record no cost, or that
    another row with different rates matches, so they get the wrong price."""
    found = []
    for model_id, source, row in _variant_ids(rows, catalogs, hosted, today):
        priced_by = lookup(rows, model_id)
        if priced_by is None or (priced_by is not row and priced_by["prices"] != row["prices"]):
            found.append(
                {
                    "model": model_id,
                    "row": row["modelName"],
                    "provider": row["provider"],
                    "source": source,
                    "priced_as": priced_by and priced_by["modelName"],
                }
            )
    return found


def find_overlaps(
    rows: list[dict], catalogs: dict[str, dict], hosted: dict[str, dict], today: datetime
) -> list[dict]:
    """Model IDs that two or more rows' patterns match at different rates, with no row
    named exactly that. The worker picks the first by modelName; the UI picks by
    database order, so the two can disagree."""
    names = {row["modelName"] for row in rows}
    candidates = {model for _, model in _live_text_models(catalogs, today)}
    candidates |= {model_id for model_id, _, _ in _variant_ids(rows, catalogs, hosted, today)}
    overlaps = []
    for model_id in sorted(candidates - names):
        matched = [row for row in _by_name(rows) if _matches(row, model_id)]
        prices = {json.dumps(row["prices"], sort_keys=True) for row in matched}
        if len(matched) > 1 and len(prices) > 1:
            overlaps.append({"model": model_id, "rows": [row["modelName"] for row in matched]})
    return overlaps


def find_row_problems(rows: list[dict]) -> list[dict]:
    """Problems in the price file itself, found without a catalog, so rows no catalog
    lists are checked too."""
    problems = []
    seen: set[str] = set()
    for row in rows:
        name, pattern = row["modelName"], row["matchPattern"]
        found = []
        if name.lower() in seen:
            found.append("modelName is listed twice")
        seen.add(name.lower())
        if _compile(pattern) is None:
            found.append("matchPattern does not compile, so the row matches its exact name only")
        else:
            if JS_INCOMPATIBLE.search(pattern):
                found.append("matchPattern uses regex syntax the UI cannot read the same way")
            if not _matches(row, name):
                found.append("matchPattern does not match the row's own modelName")
        rates = {field: _number(row["prices"].get(field)) for field in FIELDS}
        for field, rate in rates.items():
            if rate is not None and not 0 <= rate <= MAX_RATE:
                found.append(f"{FIELD_LABELS[field]} rate is outside $0-$1,000 per 1M tokens")
        if rates["cacheRead"] is not None and rates["cacheRead"] > rates["input"]:
            found.append("cache read rate is above the input rate")
        problems += [{"row": name, "problem": problem} for problem in found]
    return problems


def find_long_context(rows: list[dict], catalogs: dict[str, dict]) -> list[dict]:
    """Rows whose model a catalog charges more for above a prompt size. The price file
    has one rate per token type, so long prompts are recorded at the lower rate."""
    found = []
    for row in rows:
        key = (row["provider"], row["modelName"])
        # LiteLLM names the threshold; models.dev's context_over_200k key does not.
        tiers = [catalogs[name][key]["long_context"] for name in catalogs if key in catalogs[name]]
        above = next((tier for tier in tiers if tier), None)
        if above:
            found.append({"model": row["modelName"], "provider": row["provider"], "above": above})
    return found


def build_report(
    rows: list[dict],
    litellm: dict,
    modelsdev: dict,
    *,
    date: str,
    hosted: dict[str, dict] | None = None,
    min_compared: int = MIN_COMPARED,
) -> dict:
    """Compare every row by exact model ID, then every catalog model a row prices through
    its matchPattern. A rate is flagged only when every catalog that lists the model and
    has that rate disagrees with ours. Then check the IDs each row should match, and the
    price file itself."""
    catalogs = {"litellm": litellm, "modelsdev": modelsdev}
    hosted = hosted or {}
    today = datetime.fromisoformat(date)
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
        flagged += _flag_rates(row, provider, model, found, priced_as=None)
    if compared < min_compared:
        raise CheckError(
            f"only {compared} of {len(rows)} rows matched a catalog, below the floor of "
            f"{min_compared}; a catalog's model IDs or format may have changed"
        )
    return {
        "date": date,
        "status": "ok",
        "total": len(rows),
        "compared": compared,
        "flagged": flagged + find_shadowed(rows, catalogs, today),
        "unpriced_ids": find_unpriced_ids(rows, catalogs, hosted, today),
        "overlaps": find_overlaps(rows, catalogs, hosted, today),
        "row_problems": find_row_problems(rows),
        "missing": find_missing(rows, catalogs, today),
        "long_context": find_long_context(rows, catalogs),
        "no_match": no_match,
        "unmapped_providers": sorted(unmapped),
    }


def finding_keys(report: dict) -> dict[tuple, dict]:
    """Each finding by a key that stays the same from one price file to the next, so
    two reports can be compared."""
    keys: dict[tuple, dict] = {}
    for item in report["flagged"]:
        keys[("rate", item["model"], item["field"])] = item
    for item in report["unpriced_ids"]:
        # Which row prices it is part of the key: from no price to the wrong one is new.
        keys[("id", item["model"], item["priced_as"])] = item
    for item in report["overlaps"]:
        keys[("overlap", item["model"])] = item
    for item in report["row_problems"]:
        keys[("row", item["row"], item["problem"])] = item
    for item in report["missing"]:
        keys[("missing", item["provider"], item["model"])] = item
    for item in report["long_context"]:
        keys[("long_context", item["model"])] = item
    return keys


def describe(key: tuple) -> str:
    """A finding key in a few words, e.g. "claude-x cache read rate"."""
    match key:
        case ("rate", model, field):
            return f"{model} {FIELD_LABELS[field]} rate"
        case ("id", model, None):
            return f"{model} not priced by its row"
        case ("id", model, priced_as):
            return f"{model} priced as {priced_as}"
        case ("overlap", model):
            return f"{model} matched by two rows"
        case ("row", row, problem):
            return f"{row}: {problem}"
        case ("missing", _, model):
            return f"{model} not priced"
        case ("long_context", model):
            return f"{model} long-context rate"
    raise ValueError(f"unknown finding {key}")


def describe_all(keys: list[tuple]) -> list[str]:
    """Finding keys in a few words each, with one model's rates merged, e.g.
    "claude-x input and cache read rates"."""
    rates: dict[str, list[str]] = {}
    others = []
    for key in keys:
        if key[0] == "rate":
            rates.setdefault(key[1], []).append(FIELD_LABELS[key[2]])
        else:
            others.append(describe(key))
    merged = [
        f"{model} {_join(fields)} rate" + "s" * (len(fields) > 1) for model, fields in rates.items()
    ]
    return merged + others


def load_baseline(path: Path) -> dict:
    """A report saved by --json from a completed run. Anything else fails the run."""
    try:
        baseline = json.loads(path.read_text())
    except (OSError, ValueError) as exc:
        raise CheckError(f"could not read the baseline report ({type(exc).__name__})") from exc
    if not isinstance(baseline, dict) or baseline.get("status") != "ok":
        raise CheckError("the baseline report is not from a completed run")
    try:
        finding_keys(baseline)
    except (KeyError, TypeError) as exc:
        raise CheckError("the baseline report was written by a different version") from exc
    return baseline


def compare_reports(baseline: dict, report: dict) -> dict:
    """The findings this run fixes and adds compared with a baseline report, such as one
    saved before an edit to the price file."""
    before, after = finding_keys(baseline), finding_keys(report)
    return {
        "fixes": describe_all([key for key in before if key not in after]),
        "adds": describe_all([key for key in after if key not in before]),
    }


def apply_pr(rows: list[dict], base: list[dict], head: list[dict]) -> list[dict]:
    """The price file with a PR merged: the rows the PR adds, changes or removes between
    its merge base and its head, applied to the current rows by id. A branch that is
    behind leaves later changes to the current file alone."""
    before = {row["id"]: row for row in base}
    after = {row["id"]: row for row in head}
    changed = {row_id: row for row_id, row in after.items() if before.get(row_id) != row}
    removed = before.keys() - after.keys()
    merged = [changed.pop(row["id"], row) for row in rows if row["id"] not in removed]
    return merged + list(changed.values())


def track(report: dict, prs: list[dict], evaluate) -> None:
    """Name, on each finding, the open PRs that would clear it, and list what each PR
    would fix and add. prs holds each PR's merged price file in "rows", or why it could
    not be checked in "error"; evaluate builds a report from a price file."""
    before = finding_keys(report)
    for item in before.values():
        item["tracked_by"] = []
    checked = []
    for pr in prs:
        summary = {key: pr.get(key) for key in ("number", "title", "url", "draft", "closes")}
        if pr.get("error"):
            checked.append({**summary, "fixes": [], "adds": [], "error": pr["error"]})
            continue
        try:
            after = finding_keys(evaluate(validate_rows(pr["rows"])))
        except CheckError as exc:
            checked.append({**summary, "fixes": [], "adds": [], "error": str(exc)})
            continue
        fixes = [key for key in before if key not in after]
        for key in fixes:
            before[key]["tracked_by"].append(pr["number"])
        adds = describe_all([key for key in after if key not in before])
        checked.append({**summary, "fixes": describe_all(fixes), "adds": adds})
    report["pull_requests"] = checked
    report["tracking"] = "ok"


def _github(url: str, token: str | None):
    headers = {"User-Agent": USER_AGENT, "Accept": "application/vnd.github+json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    with urlopen(Request(url, headers=headers), timeout=TIMEOUT_SECONDS) as response:
        return json.load(response)


def _mentions(pull: dict, models: list[re.Pattern[str]]) -> bool:
    text = f"{pull.get('title') or ''}\n{pull.get('body') or ''}"
    return bool(PRICING_WORDS.search(text)) or any(model.search(text) for model in models)


def fetch_pricing_prs(repo: str, rows: list[dict], report: dict, token: str | None) -> list[dict]:
    """The open PRs in repo that change the price file, each with the price file it
    would leave on merge. A PR is looked at when its title or body mentions pricing or a
    model in the report; one whose files can't be read gets an "error" instead."""
    pulls: list[dict] = []
    for page in range(1, MAX_PR_PAGES + 1):
        batch = _github(
            f"{GITHUB_API}/repos/{repo}/pulls?state=open&per_page=100&page={page}", token
        )
        pulls += batch
        if len(batch) < 100:
            break
    names = {
        value
        for item in finding_keys(report).values()
        for value in (item.get("model"), item.get("row"))
        if value
    }
    models = [re.compile(rf"(?<![\w.-]){re.escape(name)}(?![\w-])") for name in sorted(names)]
    prs = []
    for pull in sorted(pulls, key=lambda pull: pull["number"]):
        if not _mentions(pull, models):
            continue
        number, head = pull["number"], pull["head"]["sha"]
        pr = {
            "number": number,
            "title": pull.get("title"),
            "url": pull.get("html_url"),
            "draft": bool(pull.get("draft")),
            "closes": sorted({int(n) for n in CLOSES_ISSUE.findall(pull.get("body") or "")}),
        }
        try:
            compare = _github(
                f"{GITHUB_API}/repos/{repo}/compare/{pull['base']['sha']}...{head}", token
            )
            if PRICE_PATH not in {changed["filename"] for changed in compare.get("files", [])}:
                continue
            base_sha = compare["merge_base_commit"]["sha"]
            base = fetch_json(f"{GITHUB_RAW}/{repo}/{base_sha}/{PRICE_PATH}")
            pr["rows"] = apply_pr(
                rows, base, fetch_json(f"{GITHUB_RAW}/{repo}/{head}/{PRICE_PATH}")
            )
        except (URLError, OSError, ValueError, KeyError, TypeError) as exc:
            if getattr(exc, "code", None) in (403, 429):
                raise  # GitHub's rate limit: every later PR would fail the same way.
            pr["error"] = f"could not read its price file ({type(exc).__name__})"
        prs.append(pr)
    return prs


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


def _priced_as(item: dict) -> str:
    """For a model priced through another row's pattern, which row prices it."""
    return f" (priced as {item['priced_as']})" if item.get("priced_as") else ""


def _pr_text(numbers: list[int]) -> str:
    """Open PRs as plain text, e.g. "#2902, #2948"."""
    return ", ".join(f"#{number}" for number in numbers)


def _pr_linker(report: dict):
    """A function that writes open PRs as Slack links, e.g. "<url|#2902>"."""
    urls = {pr["number"]: pr.get("url") for pr in report.get("pull_requests", [])}

    def links(numbers: list[int]) -> str:
        return ", ".join(f"<{urls[n]}|#{n}>" if urls.get(n) else f"#{n}" for n in numbers)

    return links


def _tracked(report: dict) -> bool:
    return report.get("tracking") == "ok"


def _price_table(flagged: list[dict], *, tracked: bool) -> list[str]:
    """Flagged rates as an aligned code block, one row per rate, grouped by model, with
    the open PRs that would fix each rate when --track ran."""
    cells = []
    previous = None
    for item in flagged[:MAX_FLAGGED_LINES]:
        model = item["model"] + _priced_as(item) if item["model"] != previous else ""
        previous = item["model"]
        prs = _pr_text(item["tracked_by"]) if tracked and item["tracked_by"] else ""
        cells.append(
            (model, FIELD_LABELS[item["field"]], _amount(item["ours"]), _catalog_amount(item), prs)
        )
    widths = [max(len(cell[column]) for cell in cells) for column in range(4)]
    show_prs = any(cell[4] for cell in cells)
    rows = []
    for model, field, ours, theirs, prs in cells:
        last = f"{theirs:<{widths[3]}}  {prs}".rstrip() if show_prs else theirs
        rows.append(f"{model:<{widths[0]}}  {field:<{widths[1]}}  {ours:<{widths[2]}}  → {last}")
    # Pad first, then escape: Slack shows the escaped text unescaped, so columns stay aligned.
    return ["```", *(_escape(line) for line in rows), "```"]


def _with_prs(text: str, items: list[dict], report: dict) -> str:
    """Append "(2 with an open PR)" when --track found PRs for some of the items."""
    count = sum(1 for item in items if item.get("tracked_by"))
    return f"{text} ({count} with an open PR)" if _tracked(report) and count else text


def _status_parts(report: dict) -> list[tuple[str, str]]:
    """(emoji, text) for each kind of finding, problems first, e.g.
    ("red_circle", "3 models with prices to check")."""
    flagged = report["flagged"]
    # One item per flagged model, tracked when an open PR fixes any of its rates.
    models: dict[str, dict] = {}
    for item in flagged:
        model = models.setdefault(item["model"], {"tracked_by": []})
        model["tracked_by"] += item.get("tracked_by", [])
    if flagged:
        text = f"{_plural(len(models), 'model')} with prices to check"
        parts = [("red_circle", _with_prs(text, list(models.values()), report))]
    else:
        parts = [("large_green_circle", "prices match the catalogs")]
    problems = report["row_problems"] + report["overlaps"]
    if problems:
        text = _with_prs(_plural(len(problems), "price file problem"), problems, report)
        parts.append(("red_circle", text))
    unpriced = [item for item in report["unpriced_ids"] if not item["priced_as"]]
    if unpriced:
        text = _with_prs(f"{_plural(len(unpriced), 'model ID')} with no price", unpriced, report)
        parts.append(("large_orange_circle", text))
    wrong = [item for item in report["unpriced_ids"] if item["priced_as"]]
    if wrong:
        text = _with_prs(
            f"{_plural(len(wrong), 'model ID')} priced as another model", wrong, report
        )
        parts.append(("large_orange_circle", text))
    if report["missing"]:
        text = _with_prs(
            f"{_plural(len(report['missing']), 'model')} not priced", report["missing"], report
        )
        parts.append(("large_yellow_circle", text))
    return parts


def _status(report: dict) -> str:
    """One line on what needs attention, e.g. "3 models with prices to check"."""
    return ", ".join(text for _, text in _status_parts(report))


def _split_missing(missing: list[dict]) -> tuple[dict, dict]:
    """Missing models by provider: (main list, aliases/snapshots/realtime/search)."""
    main: dict[str, list[dict]] = {}
    minor: dict[str, list[dict]] = {}
    for item in missing:
        target = minor if MINOR_MODELS.search(item["model"]) else main
        target.setdefault(item["provider"], []).append(item)
    return main, minor


def _example(ids: list[str]) -> str:
    """One ID to show for a row, preferring a US Bedrock profile as the most familiar."""
    return min(ids, key=lambda model_id: (not model_id.startswith("us."), model_id))


def _id_lines(report: dict, links) -> tuple[list[str], list[str]]:
    """Model IDs with no price, as (lines for IDs no open PR fixes, one per row, e.g.
    "• claude-x: 7 Bedrock, 1 OpenRouter, [1m], e.g. `us.anthropic.claude-x`"; lines
    naming the rows whose IDs each set of open PRs fixes)."""
    groups: dict[str, dict] = {}
    covered: dict[tuple[int, ...], list[str]] = {}
    for item in report["unpriced_ids"]:
        if item.get("tracked_by"):
            rows = covered.setdefault(tuple(item["tracked_by"]), [])
            rows += [] if item["row"] in rows else [item["row"]]
            continue
        group = groups.setdefault(item["row"], {"sources": {}, "ids": [], "wrong": []})
        if item["priced_as"]:
            group["wrong"].append(f"`{item['model']}` is priced as {item['priced_as']}")
        elif item["source"] == "1M context":
            group["sources"]["[1m]"] = 1
        else:
            group["sources"][item["source"]] = group["sources"].get(item["source"], 0) + 1
            group["ids"].append(item["model"])
    lines = []
    for row, group in sorted(groups.items()):
        parts = [
            f"{count} {source}" for source, count in group["sources"].items() if source != "[1m]"
        ]
        if group["ids"]:
            parts[-1] += f", e.g. `{_example(group['ids'])}`"
        if "[1m]" in group["sources"]:
            parts.append("[1m]")
        lines.append(f"• {_escape(row)}: {_escape(', '.join(parts + group['wrong']))}")
    covered_lines = [
        f"• _Open PR_ {links(list(prs))}: {_escape(', '.join(sorted(rows)))}"
        for prs, rows in sorted(covered.items())
    ]
    return lines, covered_lines


def _fit(heading: str, lines: list[str], limit: int) -> str:
    """The heading and as many whole lines as fit in limit characters, then a count of
    the rest."""
    text = heading
    for index, line in enumerate(lines):
        more = f"\n…and {len(lines) - index} more in the JSON report"
        if len(text) + 1 + len(line) + len(more) > limit:
            return text + more
        text += "\n" + line
    return text


def _problem_lines(report: dict, links) -> list[str]:
    """Row problems and overlapping patterns, one line each."""
    lines = []
    for item in report["row_problems"]:
        lines.append((f"• {_escape(item['row'])}: {item['problem']}", item))
    for item in report["overlaps"]:
        rows = " and ".join(item["rows"])
        text = f"{item['model']} is matched by {rows} at different prices"
        lines.append((f"• {_escape(text)}; the worker uses {_escape(item['rows'][0])}", item))
    return [
        f"{line} · {links(item['tracked_by'])}" if item.get("tracked_by") else line
        for line, item in lines
    ]


def _long_context_line(report: dict) -> str:
    models = ", ".join(
        f"{item['model']} over {item['above'] // 1000}K" for item in report["long_context"]
    )
    heading = "Long-context rates the price file has no field for"
    return f"*{heading}* ({len(report['long_context'])}): {_escape(models)}"


def _pr_warnings(report: dict, links) -> list[str]:
    """Open PRs that would add a problem, or whose price file couldn't be checked."""
    warnings = []
    for pr in report.get("pull_requests", []):
        if pr.get("error"):
            warnings.append(f"{links([pr['number']])}: {_escape(pr['error'])}")
        elif pr["adds"]:
            added = _escape(", ".join(pr["adds"][:5]))
            more = f" and {len(pr['adds']) - 5} more" if len(pr["adds"]) > 5 else ""
            warnings.append(f"{links([pr['number']])} would add: {added}{more}")
    return warnings


def _footer(report: dict) -> str:
    footer = f"Compared {report['compared']} of {report['total']} rows with LiteLLM and models.dev"
    if report["no_match"]:
        footer += f" · {len(report['no_match'])} are in neither catalog under the same ID"
    if report["unmapped_providers"]:
        footer += f" · no catalog for {', '.join(report['unmapped_providers'])}"
    if _tracked(report):
        footer += f" · checked {_plural(len(report['pull_requests']), 'open pricing PR')}"
    elif report.get("tracking"):
        footer += f" · open PRs not checked: {report['tracking']}"
    return footer


def _clip(text: str, limit: int) -> str:
    return text if len(text) <= limit else text[: limit - 1] + "…"


def _count(by_provider: dict[str, list[dict]]) -> int:
    return sum(len(items) for items in by_provider.values())


def _names(by_provider: dict[str, list[dict]], *, bullet: str, separator: str, links) -> str:
    """Model names grouped by provider, e.g. "• *openai* (2): gpt-a, gpt-b (#2952)"."""

    def name(item: dict) -> str:
        prs = item.get("tracked_by")
        return f"{_escape(item['model'])} ({links(prs)})" if prs else _escape(item["model"])

    return separator.join(
        f"{bullet}*{_escape(provider)}* ({len(items)}): {', '.join(map(name, items))}"
        for provider, items in sorted(by_provider.items())
    )


def format_report(report: dict) -> str:
    """The report as text for the terminal: what to fix first, then context."""
    flagged = report["flagged"]
    lines = [f"*Model pricing audit, {report['date']}*: {_status(report)}"]
    if "baseline" in report:
        for word in ("fixes", "adds"):
            found = report["baseline"][word]
            listed = "\n".join(f"• {_escape(item)}" for item in found) or "• nothing"
            lines += ["", f"*Compared with the baseline, this file {word}* ({len(found)})", listed]

    if flagged:
        lines += ["", "*Prices to check* (USD per 1M tokens, ours → catalogs)"]
        lines += _price_table(flagged, tracked=_tracked(report))
        if len(flagged) > MAX_FLAGGED_LINES:
            lines.append(f"…and {len(flagged) - MAX_FLAGGED_LINES} more in the JSON report")
        pages = dict.fromkeys(
            (item["provider"], item["pricing_page"]) for item in flagged if item["pricing_page"]
        )
        if pages:
            links = " · ".join(f"<{url}|{_escape(provider)}>" for provider, url in pages)
            lines.append(f"Pricing pages: {links}")

    if report["unpriced_ids"]:
        heading = f"*Model IDs with no price* ({len(report['unpriced_ids'])}): {ID_HEADING}"
        open_ids, covered = _id_lines(report, _pr_text)
        lines += ["", heading, *open_ids, *covered]
    problems = _problem_lines(report, _pr_text)
    if problems:
        lines += ["", f"*Price file problems* ({len(problems)})", *problems]

    # Every missing name appears, one line per provider, so none is cut from the report.
    main, minor = _split_missing(report["missing"])
    if main:
        body = _names(main, bullet="• ", separator="\n", links=_pr_text)
        lines += ["", f"*Not priced* ({_count(main)})", body]
    if minor:
        heading = f"*Also not priced: aliases, snapshots, realtime and search* ({_count(minor)})"
        lines += ["", heading, _names(minor, bullet="• ", separator="\n", links=_pr_text)]
    if report["long_context"]:
        lines += ["", _long_context_line(report)]
    warnings = _pr_warnings(report, _pr_text)
    if warnings:
        lines += ["", "*Open PRs to check*", *(f"• {warning}" for warning in warnings)]

    lines += ["", f"_{_escape(_footer(report))}._"]
    return "\n".join(lines)


def _mrkdwn(text: str) -> dict:
    return {"type": "mrkdwn", "text": text}


def _cell(text: str, *, url: str | None = None, bold: bool = False, note: str = "") -> dict:
    """A table cell: rich text, so it can be bold, a link or carry an italic note, with
    no mrkdwn parsing."""
    element = {"type": "link", "url": url, "text": text} if url else {"type": "text", "text": text}
    if bold:
        element["style"] = {"bold": True}
    elements = [element]
    if note:
        elements.append({"type": "text", "text": note, "style": {"italic": True}})
    return {"type": "rich_text", "elements": [{"type": "rich_text_section", "elements": elements}]}


def _price_table_block(flagged: list[dict]) -> dict:
    """Flagged rates as a table, one row per rate; the model name links to its pricing page."""
    rows = [[_cell(title, bold=True) for title in ("Model", "Rate", "Ours", "Catalogs")]]
    previous = None
    for item in flagged[:MAX_FLAGGED_LINES]:
        first = item["model"] != previous
        previous = item["model"]
        model = (
            _cell(item["model"], url=item["pricing_page"], note=_priced_as(item))
            if first
            else _cell(" ")
        )
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


def _open(items: list[dict]) -> list[dict]:
    """The findings no open PR fixes; all of them when --track didn't run."""
    return [item for item in items if not item.get("tracked_by")]


def _join(words: list[str]) -> str:
    """ "a", "a and b", "a, b and c"."""
    return words[0] if len(words) == 1 else f"{', '.join(words[:-1])} and {words[-1]}"


def _by_provider(items: list[dict]) -> str:
    """Counts by provider, largest first, e.g. "OpenAI 29, Anthropic 26"."""
    counts: dict[str, int] = {}
    for item in items:
        counts[item["provider"]] = counts.get(item["provider"], 0) + 1
    ranked = sorted(counts.items(), key=lambda pair: (-pair[1], pair[0]))
    return ", ".join(f"{PROVIDER_NAMES.get(name, name)} {count}" for name, count in ranked)


def _sources(items: list[dict]) -> str:
    """Where model IDs come from, e.g. "Bedrock, OpenRouter and [1m]"."""
    names = {"[1m]" if item["source"] == "1M context" else item["source"] for item in items}
    order = ["Bedrock", "Vertex AI", "OpenRouter", "[1m]"]
    return _join(sorted(names, key=lambda name: (order.index(name) if name in order else 9, name)))


def _main_missing(items: list[dict]) -> list[dict]:
    """Unpriced models, leaving out aliases, snapshots, realtime and search models."""
    return [item for item in items if not MINOR_MODELS.search(item["model"])]


def _problem_text(item: dict) -> str:
    if "problem" in item:
        return f"{item['row']}: {item['problem']}"
    return f"{item['model']} is matched by {_join(item['rows'])} at different prices"


def _needs_lines(report: dict) -> list[str]:
    """One bullet per kind of finding no open PR fixes, rates aside (they get a table)."""
    lines = []
    ids = _open(report["unpriced_ids"])
    unpriced = [item for item in ids if not item["priced_as"]]
    if unpriced:
        rows = {item["row"] for item in unpriced}
        verb = "records" if len(unpriced) == 1 else "record"
        hosted = [item["model"] for item in unpriced if item["source"] != "1M context"]
        example = f" Example: `{_escape(_example(hosted))}`" if hosted else ""
        lines.append(
            f"• *{_plural(len(unpriced), 'model ID')} {verb} no cost.* These are the "
            f"{_sources(unpriced)} IDs of {_plural(len(rows), 'model')} we already price: "
            f"{_by_provider(unpriced)}.{example}"
        )
    wrong = [item for item in ids if item["priced_as"]]
    if wrong:
        verb = "gets" if len(wrong) == 1 else "get"
        lines.append(
            f"• *{_plural(len(wrong), 'model ID')} {verb} another model's price*, e.g. "
            f"`{_escape(wrong[0]['model'])}` is priced as `{_escape(wrong[0]['priced_as'])}`"
        )
    problems = _open(report["row_problems"] + report["overlaps"])
    if problems:
        lines.append(
            f"• *{_plural(len(problems), 'price file problem')}*, e.g. "
            f"{_escape(_problem_text(problems[0]))}"
        )
    missing = _main_missing(_open(report["missing"]))
    if missing:
        verb = "isn't" if len(missing) == 1 else "aren't"
        lines.append(
            f"• *{_plural(len(missing), 'model')} {verb} priced at all:* {_by_provider(missing)}"
        )
    return lines


def _progress_lines(report: dict, links) -> list[str]:
    """Findings open PRs fix, grouped by PR, then PRs that would add a problem."""
    lines = []
    rates: dict[tuple[int, ...], list[dict]] = {}
    for item in report["flagged"]:
        if item.get("tracked_by"):
            rates.setdefault(tuple(item["tracked_by"]), []).append(item)
    for prs, items in rates.items():
        models = ", ".join(
            f"`{_escape(model)}`" for model in dict.fromkeys(i["model"] for i in items)
        )
        if len(items) == 1:
            item = items[0]
            change = f"${_amount(item['ours'])} → ${_catalog_amount(item)}"
            lines.append(f"• {models} {FIELD_LABELS[item['field']]} {change}: {links(list(prs))}")
        else:
            fields = list(dict.fromkeys(FIELD_LABELS[i["field"]] for i in items))
            lines.append(f"• {models} {_join(fields)}: {links(list(prs))}")
    ids = [item for item in report["unpriced_ids"] if item.get("tracked_by")]
    if ids:
        prs = sorted({number for item in ids for number in item["tracked_by"]})
        rows = {item["row"] for item in ids}
        lines.append(f"• {_sources(ids)} IDs of {_plural(len(rows), 'model')}: {links(prs)}")
    problems = [i for i in report["row_problems"] + report["overlaps"] if i.get("tracked_by")]
    if problems:
        prs = sorted({number for item in problems for number in item["tracked_by"]})
        lines.append(f"• {_plural(len(problems), 'price file problem')}: {links(prs)}")
    for item in report["missing"]:
        if item.get("tracked_by"):
            lines.append(f"• `{_escape(item['model'])}` not priced: {links(item['tracked_by'])}")
    adds: dict[tuple[str, ...], list[int]] = {}
    for pr in report.get("pull_requests", []):
        if pr.get("error"):
            lines.append(f"• :warning: {links([pr['number']])}: {_escape(pr['error'])}")
        elif pr["adds"]:
            adds.setdefault(tuple(pr["adds"]), []).append(pr["number"])
    for added, numbers in adds.items():
        more = f" and {len(added) - 3} more" if len(added) > 3 else ""
        what = _escape(", ".join(added[:3])) + more
        lines.append(f"• :warning: {links(numbers)} would add: {what}")
    return lines


def _summary(report: dict) -> str:
    """The notification text: what no open PR covers, e.g. "80 model IDs with no price"."""
    parts = []
    flagged = _open(report["flagged"])
    if flagged:
        models = dict.fromkeys(item["model"] for item in flagged)
        parts.append(f"{_plural(len(models), 'model')} with prices to check")
    ids = _open(report["unpriced_ids"])
    if ids:
        parts.append(f"{_plural(len(ids), 'model ID')} with no price")
    problems = _open(report["row_problems"] + report["overlaps"])
    if problems:
        parts.append(_plural(len(problems), "price file problem"))
    missing = _main_missing(_open(report["missing"]))
    if missing:
        parts.append(f"{_plural(len(missing), 'model')} not priced")
    if parts:
        return ", ".join(parts)
    in_prs = any(item.get("tracked_by") for item in finding_keys(report).values())
    return "everything found is in an open PR" if in_prs else "prices match the catalogs"


def _slack_footer(report: dict, report_url: str | None) -> str:
    checked = f"Checked {report['compared']} of {report['total']} rows"
    if _tracked(report):
        checked += f" and {_plural(len(report['pull_requests']), 'open pricing PR')}"
    elif report.get("tracking"):
        checked += f" · open PRs not checked: {_escape(report['tracking'])}"
    return f"<{report_url}|Full report> · {checked}" if report_url else checked


def build_payload(report: dict, report_url: str | None = None) -> dict:
    """The Slack message (Block Kit) for a completed run: what needs a fix and has no open
    PR, then what open PRs already fix. The full lists are in the report page."""
    links = _pr_linker(report)
    flagged = _open(report["flagged"])
    needs = _needs_lines(report)
    progress = _progress_lines(report, links) if _tracked(report) else []
    title = f"Model pricing audit · {report['date']}"
    blocks: list[dict] = [
        {"type": "header", "text": {"type": "plain_text", "text": _clip(title, HEADER_LIMIT)}}
    ]
    if flagged or needs:
        heading = (
            ":red_circle: *Needs a fix, no PR yet*"
            if _tracked(report)
            else (":red_circle: *Needs a fix*")
        )
        if not flagged:
            text = _fit(heading, needs, SECTION_LIMIT)
            blocks.append({"type": "section", "block_id": "needs", "text": _mrkdwn(text)})
        else:
            # The rates get a table, and the other bullets follow it.
            models = dict.fromkeys(item["model"] for item in flagged)
            heading += (
                f"\n• *{_plural(len(models), 'model')} with prices to check*, USD per 1M tokens, "
                "ours vs. the catalogs:"
            )
            blocks.append({"type": "section", "block_id": "needs", "text": _mrkdwn(heading)})
            blocks.append(_price_table_block(flagged))
            if len(flagged) > MAX_FLAGGED_LINES:
                more = f"…and {len(flagged) - MAX_FLAGGED_LINES} more rates in the full report"
                blocks.append(
                    {"type": "context", "block_id": "prices_more", "elements": [_mrkdwn(more)]}
                )
            if needs:
                text = _fit("", needs, SECTION_LIMIT).lstrip("\n")
                blocks.append({"type": "section", "block_id": "needs_more", "text": _mrkdwn(text)})
    else:
        text = (
            ":large_green_circle: *Nothing needs a fix that isn't in an open PR*"
            if progress
            else ":large_green_circle: *Prices match the catalogs, and every model ID is priced*"
        )
        blocks.append({"type": "section", "block_id": "needs", "text": _mrkdwn(text)})
    if progress:
        text = _fit(":large_yellow_circle: *In progress (open PRs)*", progress, SECTION_LIMIT)
        blocks.append({"type": "section", "block_id": "progress", "text": _mrkdwn(text)})
    footer = _clip(_slack_footer(report, report_url), CONTEXT_LIMIT)
    blocks.append({"type": "context", "block_id": "footer", "elements": [_mrkdwn(footer)]})
    return {"text": f"Model pricing audit, {report['date']}: {_summary(report)}", "blocks": blocks}


HTML_STYLE = """
:root { color-scheme: light dark; --fg: #1d1d1f; --muted: #6e6e73; --bg: #fff;
  --line: #e5e5ea; --head: #f5f5f7; --link: #0b63ce; }
@media (prefers-color-scheme: dark) { :root { --fg: #f5f5f7; --muted: #a1a1a6;
  --bg: #1c1c1e; --line: #3a3a3c; --head: #2c2c2e; --link: #64a8ff; } }
body { margin: 0 auto; max-width: 1100px; padding: 24px 16px 48px; background: var(--bg);
  color: var(--fg); font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
h1 { font-size: 22px; margin: 0 0 4px; } h2 { font-size: 17px; margin: 32px 0 4px; }
p.note { color: var(--muted); margin: 0 0 10px; } a { color: var(--link); }
.scroll { overflow-x: auto; } table { border-collapse: collapse; width: 100%; }
th, td { border-bottom: 1px solid var(--line); padding: 6px 10px; text-align: left;
  vertical-align: top; } th { background: var(--head); font-weight: 600; }
td.num { text-align: right; font-variant-numeric: tabular-nums; } code { font-size: 13px; }
"""


def _h(text) -> str:
    return html.escape(str(text))


def _html_prs(numbers: list[int], urls: dict[int, str]) -> str:
    links = [f'<a href="{_h(urls[n])}">#{n}</a>' if urls.get(n) else f"#{n}" for n in numbers or []]
    return ", ".join(links) or "—"


def _html_table(heading: str, note: str, columns: list[str], rows: list[list[str]]) -> str:
    """A report section: heading, a sentence on what it lists, and a table of
    already-escaped cells; right-aligned when a column title starts with "#"."""
    if not rows:
        return ""
    numeric = [column.startswith("#") for column in columns]
    head = "".join(f"<th>{_h(column.lstrip('#'))}</th>" for column in columns)
    body = "".join(
        "<tr>"
        + "".join(
            f'<td class="num">{cell}</td>' if numeric[i] else f"<td>{cell}</td>"
            for i, cell in enumerate(row)
        )
        + "</tr>"
        for row in rows
    )
    return (
        f"<h2>{_h(heading)} ({len(rows)})</h2><p class='note'>{_h(note)}</p>"
        f"<div class='scroll'><table><tr>{head}</tr>{body}</table></div>"
    )


def build_html(report: dict) -> str:
    """The full report as a self-contained web page: every finding, with the open PRs
    that fix it. The Slack message summarizes it and links here."""
    title = f"Model pricing audit · {report['date']}"
    if report["status"] != "ok":
        body = (
            f"<h1>{_h(title)}</h1><p><strong>The check failed:</strong> "
            f"{_h(report['error'])}. Nothing was compared, so this is not an all-clear.</p>"
        )
        return _html_page(title, body)
    urls = {pr["number"]: pr.get("url") for pr in report.get("pull_requests", [])}
    tracked = _tracked(report)

    def prs(item: dict) -> str:
        return _html_prs(item.get("tracked_by", []), urls) if tracked else "not checked"

    sections = [
        _html_table(
            "Prices to check",
            "Rates that differ by more than 3% from every catalog that lists the model, in "
            "USD per 1M tokens. Confirm on the provider's page before changing a row.",
            ["Model", "Priced by row", "Rate", "#Ours", "#Catalogs", "Open PRs"],
            [
                [
                    f'<a href="{_h(i["pricing_page"])}">{_h(i["model"])}</a>'
                    if i["pricing_page"]
                    else _h(i["model"]),
                    _h(i.get("priced_as") or i["model"]),
                    _h(FIELD_LABELS[i["field"]]),
                    _h(_amount(i["ours"])),
                    _h(_catalog_amount(i)),
                    prs(i),
                ]
                for i in report["flagged"]
            ],
        ),
        _html_table(
            "Model IDs with no price",
            "The same model under another name: the ID a span carries when the model is "
            "called through Bedrock, Vertex AI or OpenRouter, or with [1m]. The row exists, "
            "but its matchPattern misses this ID, so these spans record no cost.",
            ["Row", "Model ID", "From", "Priced as", "Open PRs"],
            [
                [
                    _h(i["row"]),
                    f"<code>{_h(i['model'])}</code>",
                    _h(i["source"]),
                    _h(i["priced_as"] or "no row"),
                    prs(i),
                ]
                for i in report["unpriced_ids"]
            ],
        ),
        _html_table(
            "Price file problems",
            "Found in the price file itself, including rows no catalog lists.",
            ["Row or ID", "Problem", "Open PRs"],
            [
                [_h(i.get("row") or i["model"]), _h(_problem_text(i).split(": ", 1)[-1]), prs(i)]
                for i in report["row_problems"] + report["overlaps"]
            ],
        ),
        _html_table(
            "Models not priced",
            "Models a catalog prices for one of our providers that no row matches at all, so "
            "spans that use them record no cost. Variants are -latest aliases, dated "
            "snapshots, and realtime and search models.",
            ["Provider", "Model", "Kind", "Listed in", "Open PRs"],
            [
                [
                    _h(PROVIDER_NAMES.get(i["provider"], i["provider"])),
                    f"<code>{_h(i['model'])}</code>",
                    "variant" if MINOR_MODELS.search(i["model"]) else "model",
                    _h(", ".join(i["in"])),
                    prs(i),
                ]
                for i in sorted(
                    report["missing"],
                    key=lambda i: (bool(MINOR_MODELS.search(i["model"])), i["provider"]),
                )
            ],
        ),
        _html_table(
            "Long-context rates",
            "Models a catalog charges more for above a prompt size. The price file has one "
            "rate per token type, so longer prompts are recorded at the lower rate.",
            ["Model", "Provider", "#Higher rate above"],
            [
                [
                    _h(i["model"]),
                    _h(PROVIDER_NAMES.get(i["provider"], i["provider"])),
                    f"{i['above'] // 1000}K tokens",
                ]
                for i in report["long_context"]
            ],
        ),
        _html_table(
            "Open pricing PRs",
            "Each PR's row changes applied to the current price file and checked again.",
            ["PR", "Title", "Fixes", "Would add"],
            [
                [
                    _html_prs([pr["number"]], urls),
                    _h(pr.get("title") or ""),
                    _h(pr.get("error") or "; ".join(pr["fixes"]) or "—"),
                    _h("; ".join(pr["adds"]) or "—"),
                ]
                for pr in report.get("pull_requests", [])
            ],
        ),
    ]
    checked = (
        f"Checked {report['compared']} of {report['total']} rows against LiteLLM and models.dev"
    )
    if tracked:
        checked += f", and {_plural(len(report['pull_requests']), 'open pricing PR')}"
    elif report.get("tracking"):
        checked += f". Open PRs not checked: {report['tracking']}"
    not_compared = ", ".join(report["no_match"])
    body = (
        f"<h1>{_h(title)}</h1><p class='note'>{_h(checked)}.</p>"
        + "".join(sections)
        + (
            f"<h2>Not compared ({len(report['no_match'])})</h2><p class='note'>Rows neither "
            f"catalog lists under the same ID.</p><p>{_h(not_compared)}</p>"
            if report["no_match"]
            else ""
        )
    )
    return _html_page(title, body)


def _html_page(title: str, body: str) -> str:
    return (
        '<!doctype html><html lang="en"><head><meta charset="utf-8">'
        '<meta name="viewport" content="width=device-width, initial-scale=1">'
        f"<title>{_h(title)}</title><style>{HTML_STYLE}</style></head>"
        f"<body>{body}</body></html>\n"
    )


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
    parser.add_argument(
        "--html", type=Path, metavar="PATH", help="also write the full report as a web page"
    )
    parser.add_argument(
        "--report-url", metavar="URL", help="link the Slack message to the full report here"
    )
    parser.add_argument(
        "--baseline",
        type=Path,
        metavar="REPORT",
        help="list what this price file fixes and adds compared with a report saved by "
        "--json; exit 2 if it adds anything",
    )
    parser.add_argument(
        "--track",
        nargs="?",
        const=GITHUB_REPO,
        metavar="OWNER/REPO",
        help=f"name the open PRs that would fix each finding (default repo {GITHUB_REPO})",
    )
    args = parser.parse_args(argv)

    webhook = os.environ.get("SLACK_WEBHOOK_URL", "").strip()
    if args.post and not webhook:
        print("--post needs SLACK_WEBHOOK_URL set to a Slack incoming webhook URL", file=sys.stderr)
        return 1

    date = datetime.now(UTC).date().isoformat()
    try:
        rows = validate_rows(json.loads(args.prices.read_text()))
        litellm_data = load_source(args.litellm, "LiteLLM")
        modelsdev_data = load_source(args.modelsdev, "models.dev")
        litellm, modelsdev = index_litellm(litellm_data), index_modelsdev(modelsdev_data)
        hosted = index_hosted(litellm_data, modelsdev_data)
        report = build_report(
            rows, litellm, modelsdev, date=date, hosted=hosted, min_compared=args.min_compared
        )
        if args.baseline:
            report["baseline"] = compare_reports(load_baseline(args.baseline), report)
        if args.track:
            token = os.environ.get("GITHUB_TOKEN") or os.environ.get("GH_TOKEN")
            try:
                prs = fetch_pricing_prs(args.track, rows, report, token)
                track(
                    report,
                    prs,
                    lambda pr_rows: build_report(
                        pr_rows, litellm, modelsdev, date=date, hosted=hosted, min_compared=0
                    ),
                )
            except (URLError, OSError, ValueError, KeyError, TypeError) as exc:
                # The findings stand without it: say PRs weren't checked, and carry on.
                detail = getattr(exc, "code", None) or type(exc).__name__
                report["tracking"] = f"GitHub could not be read ({detail})"
        text, payload = format_report(report), build_payload(report, args.report_url)
        # With --baseline, a finding the edit adds fails the check.
        status = 2 if report.get("baseline", {}).get("adds") else 0
    except Exception as exc:  # Every failure must alert; none may read as all clear.
        reason = str(exc) if isinstance(exc, CheckError) else f"{type(exc).__name__}: {exc}"
        report = {"date": date, "status": "failed", "error": reason}
        text, payload, status = format_failure(date, reason), failure_payload(date, reason), 1

    if args.json:
        args.json.write_text(json.dumps(report, indent=2) + "\n")
    if args.html:
        args.html.write_text(build_html(report))
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
