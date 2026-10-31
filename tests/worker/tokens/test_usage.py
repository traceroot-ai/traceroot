"""Unit tests for token counting."""

import tiktoken

from tests.fixtures.otel_payloads import make_attr, make_otel_payload, make_span
from worker.otel_transform import transform_otel_to_clickhouse
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

    def test_special_token_text_is_counted_as_plain_text(self):
        """A prompt that mentions a tokenizer special token is still just text to count.

        tiktoken's encode() raises ValueError on "<|endoftext|>" by default.
        """
        for text, model, encoding in (
            ("What does <|endoftext|> mean?", "gpt-4o", tiktoken.encoding_for_model("gpt-4o")),
            ("<|endoftext|>", "some-unknown-model", tiktoken.get_encoding("cl100k_base")),
        ):
            assert count_tokens(text, model) == len(encoding.encode_ordinary(text))


def test_special_token_in_one_span_does_not_fail_the_batch():
    """The estimate runs while transforming a whole export, so a raise there drops every
    trace in the batch, not just the span that mentions the token."""
    payload = make_otel_payload(
        [
            make_span("aa" * 16, "11" * 8, name="unrelated"),
            make_span(
                "bb" * 16,
                "22" * 8,
                name="ChatCompletion",
                attributes=[
                    make_attr("openinference.span.kind", "LLM"),
                    make_attr("llm.model_name", "gpt-4o"),
                    make_attr("input.value", "Explain <|endoftext|> in GPT tokenizers"),
                    make_attr("output.value", "It marks the end of a document."),
                ],
            ),
        ]
    )

    traces, spans = transform_otel_to_clickhouse(payload, project_id="proj-1")

    assert {t["trace_id"] for t in traces} == {"aa" * 16, "bb" * 16}
    (llm,) = [s for s in spans if s["name"] == "ChatCompletion"]
    encoding = tiktoken.encoding_for_model("gpt-4o")
    assert llm["input_tokens"] == len(
        encoding.encode_ordinary("Explain <|endoftext|> in GPT tokenizers")
    )
