"""Token counting for different model providers."""

import tiktoken

from .types import is_claude_model

# Approximate chars per token for Claude (~4 chars/token)
CLAUDE_CHARS_PER_TOKEN = 4


def count_tokens(text: str | None, model: str) -> int:
    """Count tokens in text for a given model.

    - OpenAI models: tiktoken (accurate)
    - Claude models: ~4 chars/token (approximate)
    - Unknown: fallback to cl100k_base
    """
    if not text:
        return 0

    if is_claude_model(model):
        return len(text) // CLAUDE_CHARS_PER_TOKEN

    # OpenAI or unknown - use tiktoken
    try:
        encoding = tiktoken.encoding_for_model(model)
    except KeyError:
        encoding = tiktoken.get_encoding("cl100k_base")

    return len(encoding.encode(text))
