"""Model type definitions and guards."""


def is_claude_model(model: str) -> bool:
    """Check if model is Anthropic Claude."""
    return model.startswith("claude")
