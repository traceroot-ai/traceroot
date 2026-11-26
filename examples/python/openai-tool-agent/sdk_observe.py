"""SDK reference example: wrap functions with observe() to create spans.

The block between the markers is synced into docs/tracing/python-sdk.mdx by
scripts/sync_doc_snippets.py.

Usage:
    python sdk_observe.py
"""

import asyncio

# [start:python-sdk-observe]
from traceroot import observe


@observe(name="my_function", type="tool")
def my_function(query: str) -> str:
    return f"Processed: {query}"


@observe(name="async_agent", type="agent")
async def async_agent(query: str) -> str:
    return f"Result: {query}"


# [end:python-sdk-observe]

if __name__ == "__main__":
    print(my_function("hello"))
    print(asyncio.run(async_agent("hello")))
