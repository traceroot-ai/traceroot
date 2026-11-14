"""Compare the price file with the catalogs: the row production prices an ID with,
flagged rates, missing models, model IDs a row misses, overlapping patterns, problems in
the file itself and long-context rates."""

import functools
import json
import re
from datetime import datetime

from .catalogs import FIELD_LABELS, FIELDS, OUR_PROVIDERS, CheckError, _number

TOLERANCE = 0.03

# Per-token rates outside this range are a unit slip, such as a per-million price.
MAX_RATE = 1e-3

# Rows compared on a normal day are well above this; far fewer means a catalog's IDs or
# layout changed, which must fail the run rather than report a quiet day.
MIN_COMPARED = 80

# A model with at least this context window is also called with a [1m] suffix.
ONE_MILLION = 1_000_000

# What a host adds around a model's own ID: a region, a vendor, a version or a date.
HOST_PREFIX = re.compile(
    r"^(?:(?:us|us-gov|eu|apac|au|jp|in|ca|global)\.)?"
    r"(?:anthropic|openai|xai|x-ai|google|deepseek|moonshotai|zai|z-ai)[./]"
)
HOST_SUFFIX = re.compile(r"(?:-\d{8})?(?:-v\d+(?::\d+)?)?(?:@\d{8})?$")

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
# the UI drops the pattern or matches other IDs: Python's named groups, \A, \Z and \z,
# comments, atomic groups, possessive quantifiers, conditionals, {,n}, and inline flag
# groups such as (?s), (?i:...) or a second (?i). One leading (?i) is fine; the UI
# strips it.
JS_INCOMPATIBLE = re.compile(
    r"\(\?P[<=>]|\\[AZz]|\(\?#|\(\?>|[*+?}]\+|\(\?\(|\{,\d*\}|(?!^\(\?i\))\(\?[-aiLmsux]+[:)]"
)

# Missing models shown in small type under the main list: -latest aliases, dated
# snapshots, and realtime, live and search models, which follow a base model's price.
MINOR_MODELS = re.compile(
    r"-latest$|-\d{4}(-\d{2}-\d{2})?$|-\d{2}-\d{4}$|-\d{4}-\d+k$|realtime|-live|search",
    re.IGNORECASE,
)


@functools.cache
def _compile(pattern: str) -> re.Pattern[str] | None:
    """The pattern as production reads it, or None when Python can't compile it,
    including a repeat count too large or groups nested too deep."""
    try:
        return re.compile(pattern, re.IGNORECASE)
    except (re.error, OverflowError, RecursionError):
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
        theirs = {name: rates[field] for name, rates in found.items() if rates[field] is not None}
        # A rate our row leaves out or sets to null is compared as production bills it:
        # those tokens at nothing, or a 1-hour cache write at the cacheWrite rate.
        billed = ours or 0.0
        if field == "cacheWrite1h" and not ours:
            billed = _number(row["prices"]["cacheWrite"]) or 0.0
        if theirs and all(differs(billed, value) for value in theirs.values()):
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
    a newer version at a different price, which a by-name comparison never sees. So can
    the dash spelling of a dotted version, such as gpt-5-5 for gpt-5.5, which gateways
    send: a date group on the gpt-5 row's pattern also matches it."""
    flags = []
    for (provider, model), found in _live_text_models(catalogs, today).items():
        row = lookup(rows, model)
        if row is not None and row["modelName"] != model:
            flags += _flag_rates(row, provider, model, found, priced_as=row["modelName"])
        # Dated snapshots and aliases would only repeat what the base model's spelling shows.
        if "." not in model or MINOR_MODELS.search(model):
            continue
        # The provider-prefixed spelling is tried only when the bare one finds no other
        # row, so each model is reported once.
        for dashed in (_family(model), f"{provider}/{_family(model)}"):
            other = lookup(rows, dashed)
            if other is not None and other is not row:
                flags += _flag_rates(other, provider, dashed, found, priced_as=other["modelName"])
                break
    return flags


def priced_dash_spellings(rows: list[dict], catalogs: dict[str, dict], today: datetime) -> dict:
    """The row that prices each dotted model's dash spelling, such as grok-4-20 for
    grok-4.20. No finding lists a dash spelling that no row prices, so --baseline and
    --track compare these to catch an edit that stops pricing one."""
    priced = {}
    for _, model in _live_text_models(catalogs, today):
        if "." not in model or MINOR_MODELS.search(model):
            continue
        row = lookup(rows, _family(model))
        if row is not None:
            priced[_family(model)] = row["modelName"]
    return dict(sorted(priced.items()))


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


def _live_hosted(hosted: dict[str, dict], today: datetime) -> list[tuple[str, dict]]:
    """The host IDs of live text models, sorted, leaving out the kinds of model the
    missing-models list leaves out."""
    return [
        (model_id, entry)
        for model_id, entry in sorted(hosted.items())
        if (entry["retired_from"] is None or entry["retired_from"] > today)
        and entry["text"]
        and not IGNORED_MODELS.search(model_id)
    ]


def _variant_ids(
    rows: list[dict], catalogs: dict[str, dict], hosted: dict[str, dict], today: datetime
) -> list[tuple[str, str, dict]]:
    """(ID, where it comes from, the row it belongs to) for each ID a row should price
    besides its own name: the model's live IDs on other hosts, and its [1m] ID when a
    catalog gives it a context window of 1M tokens or more."""
    by_family = {_family(row["modelName"]): row for row in rows}
    variants = []
    for model_id, entry in _live_hosted(hosted, today):
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
    another row with different rates matches, so they get the wrong price. A row named
    exactly the ID prices it on purpose, so the ID counts as priced; for a host ID,
    mispriced_host_ids compares that row's rates with the host's."""
    found = []
    for model_id, source, row in _variant_ids(rows, catalogs, hosted, today):
        priced_by = lookup(rows, model_id)
        if priced_by is not None and priced_by["modelName"] == model_id:
            continue
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


def mispriced_host_ids(
    rows: list[dict], catalogs: dict[str, dict], hosted: dict[str, dict], today: datetime
) -> dict:
    """Each live host ID a row prices at an input or output rate that every catalog
    listing that exact ID disagrees with, as a row at the model's own rates does for
    Bedrock's GovCloud and regional profiles: the row, and each such rate. No finding
    lists these, so --baseline and --track compare them to catch an edit that newly
    prices such an ID. A row named the ID that a catalog lists under the row's provider
    is compared by name instead; one named after a GovCloud ID is compared here."""
    found = {}
    for model_id, entry in _live_hosted(hosted, today):
        row = lookup(rows, model_id)
        if row is None:
            continue
        key = (row["provider"], row["modelName"])
        if row["modelName"] == model_id and any(key in index for index in catalogs.values()):
            continue
        flags = _flag_rates(row, row["provider"], model_id, entry["rates"], priced_as=None)
        rates = [
            {key: flag[key] for key in ("field", "ours", "litellm", "modelsdev")}
            for flag in flags
            if flag["field"] in ("input", "output")
        ]
        if rates:
            found[model_id] = {"row": row["modelName"], "rates": rates}
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
        cache_read, input_ = rates["cacheRead"], rates["input"]
        if cache_read is not None and input_ is not None and cache_read > input_:
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
    compared: list[str] = []
    no_match: list[str] = []
    unmapped: set[str] = set()
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
        compared.append(model)
        flagged += _flag_rates(row, provider, model, found, priced_as=None)
    if len(compared) < min_compared:
        raise CheckError(
            f"only {len(compared)} of {len(rows)} rows matched a catalog, below the floor of "
            f"{min_compared}; a catalog's model IDs or format may have changed"
        )
    return {
        "date": date,
        "status": "ok",
        "total": len(rows),
        "compared": len(compared),
        "flagged": flagged + find_shadowed(rows, catalogs, today),
        "unpriced_ids": find_unpriced_ids(rows, catalogs, hosted, today),
        "overlaps": find_overlaps(rows, catalogs, hosted, today),
        "row_problems": find_row_problems(rows),
        "missing": find_missing(rows, catalogs, today),
        "long_context": find_long_context(rows, catalogs),
        "dash_spellings": priced_dash_spellings(rows, catalogs, today),
        "host_rates": mispriced_host_ids(rows, catalogs, hosted, today),
        "compared_rows": compared,
        "no_match": no_match,
        "unmapped_providers": sorted(unmapped),
    }
