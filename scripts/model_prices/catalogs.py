"""Load the price file and the two public catalogs, and index the catalogs by our
provider and model ID."""

import json
import math
import re
from datetime import datetime
from pathlib import Path
from typing import Any
from urllib.error import URLError
from urllib.request import Request, urlopen

# Our price file, relative to the repository root.
PRICE_PATH = "frontend/packages/core/src/standard-model-prices.json"
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
FIELD_LABELS = {
    "input": "input",
    "output": "output",
    "cacheRead": "cache read",
    "cacheWrite": "cache write",
    "cacheWrite1h": "cache write 1h",
}

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

# LiteLLM modes that bill text tokens. The rest (embedding, image, audio, rerank, ...)
# stay out of the missing-models list. realtime stays in: live models are realtime.
TEXT_MODES = frozenset({"chat", "completion", "responses", "realtime"})


class CheckError(Exception):
    """A condition that must fail the run loudly instead of reporting all clear."""


def _number(value: object) -> float | None:
    """A rate as a float, or None when it is absent, not a number, or not finite: JSON
    can hold NaN, Infinity and integers too large for a float."""
    if isinstance(value, bool) or not isinstance(value, int | float):
        return None
    try:
        number = float(value)
    except OverflowError:
        return None
    return number if math.isfinite(number) else None


def _day(value: object) -> datetime | None:
    """A catalog date such as 2026-11-08, or None when it is absent or unreadable."""
    if not isinstance(value, str):
        return None
    try:
        return datetime.fromisoformat(value[:10])
    except ValueError:
        return None


def validate_rows(data: object) -> list[dict]:
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
        for key in ("id", "modelName", "matchPattern", "provider"):
            if not isinstance(row[key], str):
                raise CheckError(f"price file row #{index} has a non-text {key}")
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


def index_litellm(data: object) -> dict[tuple[str, str], dict]:
    """Map (our provider, model ID) to rates per token. Keys may carry a provider
    prefix, such as gemini/ or xai/, which is stripped to get the model ID."""
    if not isinstance(data, dict):
        raise CheckError("the LiteLLM catalog is not a JSON object")
    index: dict[tuple[str, str], dict] = {}
    for key, entry in data.items():
        if key == "sample_spec" or not isinstance(entry, dict):
            continue
        litellm_provider = str(entry.get("litellm_provider"))
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


def index_modelsdev(data: object) -> dict[tuple[str, str], dict]:
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


def index_hosted(litellm: object, modelsdev: object) -> dict[str, dict]:
    """The IDs other hosts serve our providers' models under, such as Bedrock's
    us.anthropic.claude-sonnet-5-5, each with its host and whether it is a live text
    model. Vertex AI's @default placeholder and OpenRouter's :free style variants are
    not IDs a span carries, so they are left out."""
    hosted: dict[str, dict] = {}
    for key, entry in litellm.items() if isinstance(litellm, dict) else ():
        host = (
            LITELLM_HOSTS.get(str(entry.get("litellm_provider")))
            if isinstance(entry, dict)
            else None
        )
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


def fetch_json(
    url: str, max_bytes: int | None = None, headers: dict[str, str] | None = None
) -> Any:
    """Fetch and parse JSON, sending headers too; with max_bytes, a larger file is a
    CheckError."""
    request = Request(url, headers={"User-Agent": USER_AGENT, **(headers or {})})
    with urlopen(request, timeout=TIMEOUT_SECONDS) as response:
        body = response.read() if max_bytes is None else response.read(max_bytes + 1)
    if max_bytes is not None and len(body) > max_bytes:
        raise CheckError(f"{url} is over {max_bytes} bytes")
    return json.loads(body)


def load_source(source: str, label: str) -> Any:
    """Load a catalog from a URL or a local file. Any failure fails the run."""
    try:
        if source.startswith(("https://", "http://")):
            return fetch_json(source)
        return json.loads(Path(source).read_text())
    except (URLError, OSError, ValueError) as exc:
        raise CheckError(f"could not load the {label} catalog ({type(exc).__name__})") from exc
