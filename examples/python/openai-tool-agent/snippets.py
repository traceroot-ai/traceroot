# ruff: noqa
"""Sourced doc snippets for TraceRoot Python SDK and Tracing documentation.

These snippets are extracted by scripts/sync_doc_snippets.py into docs/snippets/
and synced into docs/tracing/*.mdx. CI verifies they do not drift.
"""

# [start:tracing-get-started-python]
import traceroot
from traceroot import Integration
from openai import OpenAI

# This single line instruments all OpenAI API calls
traceroot.initialize(integrations=[Integration.OPENAI])

client = OpenAI()
# [end:tracing-get-started-python]


# [start:tracing-cost-tracking-python]
import traceroot
from traceroot import Integration

traceroot.initialize(integrations=[Integration.OPENAI])

# All OpenAI calls are now automatically tracked — tokens, cost, model
client.chat.completions.create(...)
# [end:tracing-cost-tracking-python]


# [start:python-sdk-init]
import traceroot
from traceroot import Integration

traceroot.initialize(
    integrations=[
        Integration.OPENAI,
        Integration.ANTHROPIC,
        Integration.LANGCHAIN,
        Integration.GOOGLE_GENAI,
    ],
)
# [end:python-sdk-init]


# [start:python-sdk-observe]
from traceroot import observe


@observe(name="my_function", type="tool")
def my_function(query: str) -> str:
    return do_work(query)


@observe(name="async_agent", type="agent")
async def async_agent(query: str) -> str:
    return await process(query)


# [end:python-sdk-observe]
