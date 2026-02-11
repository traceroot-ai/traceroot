"""
Multi-agent code generator using LangGraph.

A pipeline of 4 agents:
  Plan -> Code -> Execute -> Summarize

With automatic retry on execution failure (up to 2 retries).
"""

import logging
import os
import subprocess
import sys
import tempfile
from typing import Any, TypedDict

from langchain.prompts import ChatPromptTemplate
from langchain_openai import ChatOpenAI
from langgraph.graph import END, StateGraph
from pydantic import BaseModel, Field

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# State
# ---------------------------------------------------------------------------


class AgentState(TypedDict):
    query: str
    is_coding: bool
    plan: str
    code: str
    execution_result: dict[str, Any]
    response: str | None
    retry_count: int
    max_retries: int
    last_summary: str


# ---------------------------------------------------------------------------
# Plan agent
# ---------------------------------------------------------------------------


class PlanResponse(BaseModel):
    is_coding: bool = Field(description="Whether the query is coding-related")
    plan: str | None = Field(default=None, description="Plan for coding tasks")
    response: str | None = Field(default=None, description="Direct response for non-coding queries")


def plan_node(state: AgentState) -> dict:
    llm = ChatOpenAI(model="gpt-4o", temperature=0)
    prompt = ChatPromptTemplate.from_messages(
        [
            (
                "system",
                "You are a planning agent. Determine if the query is coding-related. "
                "If yes, set is_coding=true and provide a concise plan. "
                "If not, set is_coding=false and answer directly. "
                "If a previous summary is provided, learn from failures and improve.",
            ),
            ("human", "{query}"),
        ]
    )

    query = state["query"]
    if state["last_summary"]:
        query = f"{query}\n\nPrevious attempt summary:\n{state['last_summary']}"

    chain = prompt | llm.with_structured_output(PlanResponse)
    result = chain.invoke({"query": query})

    return {
        "is_coding": result.is_coding,
        "plan": result.plan or "",
        "response": result.response,
    }


# ---------------------------------------------------------------------------
# Code agent
# ---------------------------------------------------------------------------


def code_node(state: AgentState) -> dict:
    llm = ChatOpenAI(model="gpt-4o", temperature=0)
    prompt = ChatPromptTemplate.from_messages(
        [
            (
                "system",
                "You are a Python coding agent. Write clean, executable Python code. "
                "Include necessary imports. Return ONLY the code, no explanations. "
                "If historical context is provided, avoid repeating previous mistakes.",
            ),
            ("human", "{query}\n\nPlan: {plan}\n\nContext: {context}\n\nWrite the Python code."),
        ]
    )

    chain = prompt | llm
    response = chain.invoke(
        {
            "query": state["query"],
            "plan": state["plan"],
            "context": state["last_summary"],
        }
    )

    code = response.content.strip()
    if code.startswith("```python"):
        code = code[9:]
    elif code.startswith("```"):
        code = code[3:]
    if code.endswith("```"):
        code = code[:-3]

    return {"code": code.strip()}


# ---------------------------------------------------------------------------
# Execution agent
# ---------------------------------------------------------------------------


def execute_node(state: AgentState) -> dict:
    try:
        with tempfile.NamedTemporaryFile(mode="w", suffix=".py", delete=False) as f:
            f.write(state["code"])
            tmp = f.name

        result = subprocess.run(
            [sys.executable, tmp],
            capture_output=True,
            text=True,
            timeout=30,
        )
        return {
            "execution_result": {
                "success": result.returncode == 0,
                "stdout": result.stdout,
                "stderr": result.stderr,
            }
        }
    except subprocess.TimeoutExpired:
        return {
            "execution_result": {"success": False, "stdout": "", "stderr": "Timed out after 30s"}
        }
    except Exception as e:
        return {"execution_result": {"success": False, "stdout": "", "stderr": str(e)}}
    finally:
        try:
            os.unlink(tmp)
        except Exception:
            pass


# ---------------------------------------------------------------------------
# Summarize agent
# ---------------------------------------------------------------------------


def summarize_node(state: AgentState) -> dict:
    if not state["is_coding"]:
        return {"response": state["response"]}

    llm = ChatOpenAI(model="gpt-4o", temperature=0)
    prompt = ChatPromptTemplate.from_messages(
        [
            (
                "system",
                "Summarize the coding task result. Be concise and helpful. "
                "Show the output or explain errors.",
            ),
            (
                "human",
                "Query: {query}\nPlan: {plan}\nCode:\n```python\n{code}\n```\n"
                "Success: {success}\nOutput: {stdout}\nError: {stderr}\n"
                "Retry #{retry_count}",
            ),
        ]
    )

    er = state["execution_result"]
    chain = prompt | llm
    response = chain.invoke(
        {
            "query": state["query"],
            "plan": state["plan"],
            "code": state["code"],
            "success": er.get("success", False),
            "stdout": er.get("stdout", ""),
            "stderr": er.get("stderr", ""),
            "retry_count": state["retry_count"],
        }
    )

    return {
        "response": response.content,
        "last_summary": response.content,
        "retry_count": state["retry_count"] + (0 if er.get("success") else 1),
    }


# ---------------------------------------------------------------------------
# Graph
# ---------------------------------------------------------------------------


def _should_code(state: AgentState) -> str:
    return "code" if state["is_coding"] else "end"


def _should_retry(state: AgentState) -> str:
    er = state["execution_result"]
    if state["is_coding"] and not er.get("success") and state["retry_count"] < state["max_retries"]:
        return "retry"
    return "end"


def build_graph():
    wf = StateGraph(AgentState)
    wf.add_node("planning", plan_node)
    wf.add_node("coding", code_node)
    wf.add_node("execute", execute_node)
    wf.add_node("summarize", summarize_node)

    wf.set_entry_point("planning")
    wf.add_conditional_edges("planning", _should_code, {"code": "coding", "end": "summarize"})
    wf.add_edge("coding", "execute")
    wf.add_edge("execute", "summarize")
    wf.add_conditional_edges("summarize", _should_retry, {"retry": "planning", "end": END})

    return wf.compile()


def process_query(query: str) -> str:
    graph = build_graph()
    result = graph.invoke(
        {
            "query": query,
            "is_coding": False,
            "plan": "",
            "code": "",
            "execution_result": {},
            "response": None,
            "retry_count": 0,
            "max_retries": 2,
            "last_summary": "",
        }
    )
    return result["response"]
