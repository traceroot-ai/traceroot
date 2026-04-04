"""
DeepAgents multi-agent research pipeline with Traceroot observability.

A supervisor agent orchestrates two sub-agents:
  - research-agent: fetches live web data via Tavily search
  - critique-agent: evaluates research quality and identifies gaps

Usage:
    cp .env.example .env  # fill in your API keys
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

traceroot.initialize(integrations=[Integration.LANGCHAIN])

import os

from deepagents import create_deep_agent

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Tools
# ---------------------------------------------------------------------------


def web_search(query: str) -> str:
    """Search the web for up-to-date information on a topic."""
    tavily_key = os.environ.get("TAVILY_API_KEY")
    if tavily_key:
        from tavily import TavilyClient

        results = TavilyClient(api_key=tavily_key).search(query=query, max_results=5)
        snippets = [
            f"[{r['title']}]({r['url']})\n{r['content']}" for r in results.get("results", [])
        ]
        return "\n\n".join(snippets) if snippets else "No results found."

    # Mock search — returns plausible research data for demo purposes
    return f"""[Mock search results for: "{query}"]

1. LangGraph 0.4 (LangChain, 2025) — Stateful multi-agent orchestration with persistent checkpoints and streaming.
   Source: https://blog.langchain.dev/langgraph-0-4/

2. Claude Agent SDK (Anthropic, 2025) — High-level SDK for Claude-powered agents with tool use and computer use capabilities.
   Source: https://docs.anthropic.com/agent-sdk

3. DeepAgents (LangChain, 2025) — Framework for autonomous deep-research agents with multi-agent delegation.
   Source: https://github.com/langchain-ai/deepagentsjs

4. Mastra (2025) — TypeScript-first agent framework with built-in memory and native OpenTelemetry observability.
   Source: https://mastra.ai

5. OpenAI Agents SDK (OpenAI, 2025) — Python/TypeScript SDK for multi-agent handoffs with built-in tracing.
   Source: https://platform.openai.com/docs/agents"""


# ---------------------------------------------------------------------------
# Sub-agents
# ---------------------------------------------------------------------------

research_subagent = {
    "name": "research-agent",
    "description": "Searches the web to gather current, factual information on a topic.",
    "system_prompt": (
        "You are a thorough research agent. Use web_search to collect information "
        "from multiple angles. Cite sources and organise findings clearly."
    ),
    "tools": [web_search],
}

critique_subagent = {
    "name": "critique-agent",
    "description": "Reviews research output for accuracy, completeness, and bias.",
    "system_prompt": (
        "You are a critical analyst. Evaluate the research provided to you: "
        "identify factual gaps, potential bias, and unanswered questions. "
        "Suggest what additional research would strengthen the report."
    ),
    "tools": [],
}


# ---------------------------------------------------------------------------
# Supervisor agent
# ---------------------------------------------------------------------------

SUPERVISOR_PROMPT = (
    "You are a research supervisor. For each query:\n"
    "1. Delegate information gathering to research-agent.\n"
    "2. Pass the findings to critique-agent for review.\n"
    "3. Synthesise both outputs into a final, well-structured report.\n"
    "Be concise and cite sources where available."
)

supervisor = create_deep_agent(
    model="claude-sonnet-4-6",
    system_prompt=SUPERVISOR_PROMPT,
    subagents=[research_subagent, critique_subagent],
)


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

DEMO_QUERY = "What are the latest developments in AI agent frameworks in 2025?"


@observe(name="research_session", type="agent")
def run_research(query: str) -> str:
    logger.info(f"Query: {query}")
    result = supervisor.invoke({"messages": [{"role": "user", "content": query}]})
    messages = result.get("messages", [])
    answer = messages[-1].content if messages else "(no output)"
    return answer


if __name__ == "__main__":
    with using_attributes(user_id="demo-user", session_id="deepagents-py-session"):
        report = run_research(DEMO_QUERY)

    print("\n" + "=" * 60)
    print("Final Report")
    print("=" * 60)
    print(report)

    traceroot.flush()
