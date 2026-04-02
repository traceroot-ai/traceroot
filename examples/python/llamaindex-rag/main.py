"""
LlamaIndex RAG pipeline with TraceRoot observability.

Demonstrates an in-memory RAG pipeline with document ingestion,
vector search retrieval, and LLM response synthesis.

Usage:
    cp .env.example .env
    uv run --no-project --python 3.13 --with-requirements requirements.txt python main.py
"""

import logging

from dotenv import find_dotenv, load_dotenv

dotenv_path = find_dotenv()
if dotenv_path:
    load_dotenv(dotenv_path)
else:
    print("No .env file found (find_dotenv returned None).\nUsing process environment variables.")

import traceroot
from traceroot import Integration, observe, using_attributes

traceroot.initialize(integrations=[Integration.LLAMA_INDEX])

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# RAG Pipeline
# ---------------------------------------------------------------------------

from llama_index.core import Document, Settings, VectorStoreIndex
from llama_index.llms.openai import OpenAI

# Set up LLM with explicit model for cost tracking
Settings.llm = OpenAI(model="gpt-4o-mini")

# Create documents about TraceRoot
documents = [
    Document(
        text=(
            "TraceRoot is an open-source observability platform for AI agents. "
            "It captures traces, debugs with AI, and helps ship with confidence. "
            "The platform is built on OpenTelemetry and supports BYOK for any model provider."
        )
    ),
    Document(
        text=(
            "TraceRoot supports OpenTelemetry-compatible tracing via a Python SDK. "
            "You can capture LLM calls, agent actions, and tool usage. "
            "The SDK provides auto-instrumentation for OpenAI, Anthropic, LangChain, "
            "LlamaIndex, CrewAI, and more."
        )
    ),
    Document(
        text=(
            "TraceRoot provides agentic debugging with AI-native root cause analysis "
            "and GitHub integration. It connects to a sandbox with your production "
            "source code, identifies the exact failing line, and cross-references "
            "your GitHub history to root-cause failures."
        )
    ),
    Document(
        text=(
            "TraceRoot offers both cloud and self-hosting options. The cloud version "
            "provides ample storage and LLM tokens for testing. Self-hosting supports "
            "developer mode (local), Docker mode, and Terraform (AWS) deployments."
        )
    ),
    Document(
        text=(
            "TraceRoot tracks token usage, cost, and latency across all LLM calls. "
            "It supports session tracking, user tracking, and metadata tagging. "
            "The billing system uses a high-water mark to ensure accurate usage tracking."
        )
    ),
]

# Build index
logger.info("Building vector index from %d documents...", len(documents))
index = VectorStoreIndex.from_documents(documents)
query_engine = index.as_query_engine()
logger.info("Index ready.")


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

DEMO_QUERIES = [
    "What is TraceRoot and what are its main features?",
    "How does TraceRoot handle debugging and root cause analysis?",
    "What deployment options does TraceRoot support?",
]


@observe(name="rag_demo", type="agent")
def run_demo():
    for i, query in enumerate(DEMO_QUERIES, 1):
        print(f"\n{'=' * 60}")
        print(f"Query {i}: {query}")
        print("=" * 60)
        response = query_engine.query(query)
        print(f"\nAnswer: {response}\n")


if __name__ == "__main__":
    with using_attributes(user_id="example-user", session_id="llamaindex-session"):
        run_demo()
    traceroot.flush()
