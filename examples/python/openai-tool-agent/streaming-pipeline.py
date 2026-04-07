"""
OpenAI streaming pipeline with @observe generator support.

Demonstrates the pattern where @observe wraps a function that *yields*
tokens rather than returning a complete response. Traceroot keeps the
span open until the full stream is consumed, so you see the real
end-to-end latency in the trace — not just the time to first token.

Two patterns are shown:
  1. Direct streaming  — @observe on an async generator that yields raw tokens.
  2. Pipeline streaming — a second @observe layer that transforms the token
     stream (e.g. upper-cases) before handing it to the caller.

Why this matters for observability:
  Without generator support, @observe would close the span at the moment
  the generator object is returned — before any tokens arrive. The trace
  would show near-zero latency and no output. With generator support the
  span closes only after the last token, capturing the real duration and
  the full assembled output.

Usage:
    cp .env.example .env          # set OPENAI_API_KEY and TRACEROOT_API_KEY
    pip install -r requirements.txt
    python streaming-pipeline.py
"""

import asyncio

from dotenv import find_dotenv, load_dotenv

dotenv_path = find_dotenv()
if dotenv_path:
    load_dotenv(dotenv_path)
else:
    print("No .env file found. Using process environment variables.")

import openai

import traceroot
from traceroot import Integration, observe, using_attributes

traceroot.initialize(integrations=[Integration.OPENAI])

_client = openai.AsyncOpenAI()


# ---------------------------------------------------------------------------
# Pattern 1: direct streaming
#
# stream_tokens() is an async generator decorated with @observe.
# Each call to `async for token in stream_tokens(prompt)` yields one
# text chunk. The span stays open while tokens are flowing and closes
# after the last chunk — capturing total latency and the assembled text.
# ---------------------------------------------------------------------------


@observe(name="stream_tokens", type="llm")
async def stream_tokens(prompt: str):
    """Yield raw text tokens from the OpenAI streaming API."""
    stream = await _client.chat.completions.create(
        model="gpt-4o-mini",
        messages=[{"role": "user", "content": prompt}],
        stream=True,
    )
    async for chunk in stream:
        token = chunk.choices[0].delta.content if chunk.choices else None
        if token:
            yield token


# ---------------------------------------------------------------------------
# Pattern 2: pipeline streaming
#
# transform_stream() wraps stream_tokens() and applies a transformation
# to each token. Both functions are @observe generators, so Traceroot
# creates two spans: transform_stream as parent, stream_tokens as child.
# The parent span closes only after all transformed tokens are consumed.
# ---------------------------------------------------------------------------


@observe(name="transform_stream", type="span")
async def transform_stream(prompt: str, uppercase: bool = False):
    """Yield transformed tokens — optionally upper-cased."""
    async for token in stream_tokens(prompt):
        yield token.upper() if uppercase else token


# ---------------------------------------------------------------------------
# Agent: runs both patterns for a given query
# ---------------------------------------------------------------------------


@observe(name="run_query", type="agent")
async def run_query(query: str):
    print(f"\n{'=' * 60}")
    print(f"Query: {query}")
    print("=" * 60)

    # --- Pattern 1: direct ---
    print("\n[Pattern 1 — direct stream]")
    print("Response: ", end="", flush=True)
    async for token in stream_tokens(query):
        print(token, end="", flush=True)
    print()

    # --- Pattern 2: pipeline (uppercase transform) ---
    print("\n[Pattern 2 — pipeline stream, uppercased]")
    print("Response: ", end="", flush=True)
    async for token in transform_stream(query, uppercase=True):
        print(token, end="", flush=True)
    print()


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

DEMO_QUERIES = [
    "In one sentence, what is observability?",
    "In one sentence, why does latency matter in LLM apps?",
]


@observe(name="streaming_demo", type="agent")
async def main():
    for query in DEMO_QUERIES:
        await run_query(query)


if __name__ == "__main__":
    with using_attributes(user_id="example-user", session_id="streaming-pipeline-demo"):
        asyncio.run(main())
    traceroot.flush()
