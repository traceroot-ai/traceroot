"""Model type definitions and guards."""

# OpenAI models that use tiktoken
TIKTOKEN_MODELS = [
    "gpt-4o",
    "gpt-4o-mini",
    "gpt-4-turbo",
    "gpt-4",
    "gpt-3.5-turbo",
    "o1",
    "o1-mini",
    "o1-preview",
    "o3-mini",
]

# Claude models (use char approximation)
CLAUDE_MODELS = [
    "claude-3-5-sonnet",
    "claude-3-5-haiku",
    "claude-3-opus",
    "claude-3-sonnet",
    "claude-3-haiku",
    "claude-sonnet-4",
]


def is_openai_model(model: str) -> bool:
    """Check if model uses tiktoken."""
    return any(model.startswith(m) for m in TIKTOKEN_MODELS)


def is_claude_model(model: str) -> bool:
    """Check if model is Anthropic Claude."""
    return model.startswith("claude")
