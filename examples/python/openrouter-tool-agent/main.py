"""
OpenRouter chat example with TraceRoot OpenAI instrumentation.

Usage:
    cp .env.example .env
    pip install -r requirements.txt
    python main.py
"""

import os

from dotenv import find_dotenv, load_dotenv
from openai import OpenAI

import traceroot
from traceroot import Integration, observe, using_attributes

dotenv_path = find_dotenv()
if dotenv_path:
    load_dotenv(dotenv_path)

traceroot.initialize(integrations=[Integration.OPENAI])

client = OpenAI(
    api_key=os.environ["OPENROUTER_API_KEY"],
    base_url="https://openrouter.ai/api/v1",
)
model = os.getenv("OPENROUTER_MODEL", "anthropic/claude-3-5-sonnet")


@observe(name="openrouter_chat", type="llm")
def run_chat() -> str:
    response = client.chat.completions.create(
        model=model,
        messages=[
            {
                "role": "system",
                "content": "You are a concise assistant explaining observability concepts.",
            },
            {
                "role": "user",
                "content": "Explain why tracing is useful for AI agents in two sentences.",
            },
        ],
    )
    return response.choices[0].message.content or ""


if __name__ == "__main__":
    with using_attributes(
        user_id="openrouter-example-user",
        session_id="openrouter-python-demo",
        tags=["demo", "openrouter", "openai-compatible"],
    ):
        print(run_chat())
    traceroot.flush()