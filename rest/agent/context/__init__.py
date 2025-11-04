"""Agent context utilities for trace and chat history management."""

from rest.agent.context.chat_context import build_chat_history_messages
from rest.agent.context.trace_context import get_trace_context_messages
from rest.agent.context.tree import (
    LogNode,
    SpanNode,
    build_heterogeneous_tree,
    convert_log_entry_to_log_node,
    convert_span_to_span_node,
    create_logs_map,
)

__all__ = [
    "build_chat_history_messages",
    "get_trace_context_messages",
    "LogNode",
    "SpanNode",
    "build_heterogeneous_tree",
    "convert_log_entry_to_log_node",
    "convert_span_to_span_node",
    "create_logs_map",
]
