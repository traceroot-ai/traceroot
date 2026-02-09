"""Unit tests for token counting."""

from worker.tokens.usage import CLAUDE_CHARS_PER_TOKEN, count_tokens


class TestCountTokens:
    def test_openai_model(self):
        """OpenAI models use tiktoken."""
        tokens = count_tokens("Hello, world!", "gpt-4o")
        assert tokens > 0

    def test_claude_model(self):
        """Claude models use len(text) // 4 approximation."""
        text = "a" * 100
        tokens = count_tokens(text, "claude-3-5-sonnet")
        assert tokens == 100 // CLAUDE_CHARS_PER_TOKEN

    def test_unknown_model_uses_fallback(self):
        """Unknown models fall back to cl100k_base encoding."""
        tokens = count_tokens("Hello, world!", "some-unknown-model")
        assert tokens > 0

    def test_empty_text_returns_zero(self):
        assert count_tokens("", "gpt-4o") == 0

    def test_none_text_returns_zero(self):
        assert count_tokens(None, "gpt-4o") == 0
