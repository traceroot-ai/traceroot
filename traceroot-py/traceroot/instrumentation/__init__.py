"""Auto-instrumentation for LLM libraries."""

from traceroot.instrumentation.registry import Integration, initialize_integrations

__all__ = [
    "Integration",
    "initialize_integrations",
]
