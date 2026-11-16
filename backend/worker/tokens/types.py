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
#
# Hosts that serve open models at their own rates (groq, together_ai,
# fireworks_ai) are left out on purpose: stripping them would bill
# `together_ai/moonshotai/Kimi-K2.6` at Moonshot's first-party price, a
# plausible-looking number the host does not charge. Their ids stay unpriced.
GATEWAY_PREFIXES = frozenset(
    {
        "amazon_bedrock",
        "anthropic",
        "azure",
        "azure_ai",
        "bedrock",
        "bedrock_converse",
        "deepseek",
        "gemini",
        "google",
        "googleai",
        "litellm",
        "litellm_proxy",
        "mistral",
        "mistralai",
        "models",
        "moonshot",
        "moonshotai",
        "openai",
        "openrouter",
        "portkey",
        "vertex_ai",
        "vertexai",
        "x-ai",
        "xai",
        "z-ai",
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
    shapes rather than simple slash prefixes, so they pass through here unchanged.
    Bedrock's is recognised by the catalogue patterns; the Vertex ``@date`` form
    mostly is not. 15 of the 23 Claude entries carry an ``@`` alternation, but for
    the 4.x models it is spelled family first (``claude-4-5-sonnet@…``) while Vertex
    sends ``claude-sonnet-4-5@20250929``, so only 7 entries match ``<name>@date``
    and ids like ``vertex_ai/claude-sonnet-4-5@20250929`` still price at $0. That gap
    predates the prefix stripping, and closing it belongs with the catalogue
    patterns rather than here, since it is a suffix rather than a prefix.

    The set carries two spellings of several vendors on purpose. A router does not
    have to agree with LiteLLM on how to spell the vendor it proxies: OpenRouter
    writes ``z-ai``, ``moonshotai``, ``x-ai`` and ``mistralai`` where LiteLLM writes
    ``zai``, ``moonshot``, ``xai`` and ``mistral``. Carrying only one spelling
    leaves ``openrouter/z-ai/glm-4.6`` unpriced while ``zai/glm-4.6`` resolves, and
    that gap is invisible for the vendors whose two spellings happen to coincide.
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
    ``cl100k_base`` instead of the Claude estimator. The two disagree by a margin
    that depends on the content and does not favour either direction, so the
    estimate turns on which one is picked — and the price fallback now attaches a
    real cost to whichever answer comes back.

    Bedrock and its regional aliases qualify the family name with dots rather than
    slashes (``us.anthropic.claude-opus-4-8``), so the name is not always the
    leading segment and a bare ``startswith`` misses it. The catalogue prices that
    shape, so the estimator has to recognise it too.

    A dot segment beginning with ``claude`` is not on its own enough to say a model
    is Claude: ``my-org.claude-proxy`` is somebody else's routing name, and pricing
    treats it as unknown. So the dotted form additionally requires the ``anthropic``
    qualifier the catalogue's Bedrock patterns require, which keeps classification
    no wider than what pricing will match.
    """
    segments = strip_gateway_prefixes(model).split(".")
    if segments[0].startswith("claude"):
        return True
    return "anthropic" in segments and any(segment.startswith("claude") for segment in segments)
