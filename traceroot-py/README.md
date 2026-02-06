# Traceroot Python SDK

Observability for LLM applications.

## Installation

```bash
pip install traceroot
```

With auto-instrumentation support:

```bash
pip install traceroot[openai]      # OpenAI support
pip install traceroot[anthropic]   # Anthropic support
pip install traceroot[all]         # All providers
```

## Quick Start

```python
import traceroot

# Initialize with auto-instrumentation
traceroot.initialize(api_key="tr_...")

# Now all OpenAI/Anthropic calls are automatically traced
from openai import OpenAI
client = OpenAI()
response = client.chat.completions.create(
    model="gpt-4",
    messages=[{"role": "user", "content": "Hello!"}]
)

# Graceful shutdown
traceroot.flush()
```

## Manual Instrumentation

```python
from traceroot import observe

@observe(name="process_query", type="tool")
def process_query(query: str) -> str:
    # Your code here
    return result

# Async support
@observe(name="async_process")
async def async_process(data):
    return await some_async_call(data)
```

## Session Management

Group related traces into sessions to track multi-step agent workflows:

```python
from traceroot import using_attributes

with using_attributes(session_id="conv-123", user_id="user-456"):
    # All traces in this block get session_id and user_id
    response = run_agent_workflow(query)
```

## Configuration

```env
TRACEROOT_API_KEY=tr_...
TRACEROOT_HOST_URL=https://api.traceroot.ai  # or self-hosted URL
```

Or programmatically:

```python
traceroot.initialize(
    api_key="tr_...",
    host_url="https://api.traceroot.ai",
)
```
