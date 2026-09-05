"""Model type definitions and guards."""

# Gateway / router prefixes stripped before a model id is interpreted.
#
# Every catalogue pattern hand-encodes which prefixes it tolerates, so coverage
# drifts between siblings (`gpt-5.6-sol` accepts `azure/`, `gpt-5.4` does not) and
# no entry accepts the router prefixes real deployments emit. Normalizing once
# here fixes every row at the same time, and a new gateway costs one line instead
# of an edit to all ~87 patterns.
#
# This lives beside is_claude_model rather than in pricing.py because a prefixed
# id has to mean the same model to *every* reader of it — the price lookup and the
# token estimator both — and usage.py cannot import pricing.py without a cycle.
#
# Keep in sync with GATEWAY_PREFIXES in
# frontend/packages/core/src/model-pricing/lookup.ts — the two lookups must agree
# on what a model id means. tests/worker/tokens/test_gateway_prefix_parity.py
# fails if they drift.
GATEWAY_PREFIXES = frozenset(
    {
        "amazon_bedrock",
        "anthropic",
        "azure",
        "azure_ai",
        "bedrock",
        "deepseek",
        "fireworks_ai",
        "google",
        "googleai",
        "groq",
        "litellm",
        "mistral",
        "models",
        "moonshot",
        "openai",
        "openrouter",
        "portkey",
        "together_ai",
        "vertex_ai",
        "vertexai",
        "xai",
        "zai",
    }
)

# Chained prefixes in the wild are at most two deep ("openrouter/anthropic/…"),
# so three is slack, not a limit anyone reaches. Bounding the loop keeps a
# pathological id from turning into a long walk.
_MAX_PREFIX_DEPTH = 3


def strip_gateway_prefixes(model: str) -> str:
    """Drop leading gateway/router segments from a model id.

    ``openrouter/anthropic/claude-opus-4-8`` -> ``claude-opus-4-8``.

    Only segments in GATEWAY_PREFIXES are removed, so an id whose first segment is
    part of the model's real name is returned untouched. Bedrock's
    ``us.anthropic.claude-…`` and Vertex's ``model@date`` forms are distinct id
    shapes rather than simple slash prefixes, and the catalogue patterns already
    handle them, so they pass through here unchanged.
    """
    for _ in range(_MAX_PREFIX_DEPTH):
        head, separator, tail = model.partition("/")
        if not separator or head.lower() not in GATEWAY_PREFIXES or not tail:
            break
        model = tail
    return model


def is_claude_model(model: str) -> bool:
    """Check if model is Anthropic Claude.

    Normalized first: ``openrouter/anthropic/claude-opus-4-8`` is a Claude model,
    and answering False for it sends the token estimator to tiktoken's
    ``cl100k_base`` instead of the Claude estimator.
    """
    return strip_gateway_prefixes(model).startswith("claude")
