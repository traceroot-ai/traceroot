"""OpenAI Cost Tracking Example — traceroot Observability.

Demonstrates automatic token counting and cost calculation using a priced model ID.

Usage:
    python cost_tracking.py
"""

from dotenv import find_dotenv, load_dotenv

dotenv_path = find_dotenv()
if dotenv_path:
    load_dotenv(dotenv_path)

# [start:tracing-cost-tracking-python]
from openai import OpenAI

import traceroot
from traceroot import Integration

traceroot.initialize(integrations=[Integration.OPENAI])
client = OpenAI()

# OpenAI calls are tracked automatically; cost requires a priced model ID
client.chat.completions.create(
    model="gpt-4o",
    messages=[{"role": "user", "content": "Hello"}],
)
# [end:tracing-cost-tracking-python]

traceroot.flush()
