"""Example: Using the Agent Workflow System

This example demonstrates how to use the agent workflow system to route
user queries to appropriate specialized subagents.

The workflow system implements the pattern described in issue #85:
"A workflow to redirect to some agents" - for example, redirecting
GitHub PR queries to the Code Agent (GitHub subagent).
"""

import asyncio
import os

from openai import AsyncOpenAI

# Import workflow components
from rest.agent import (
    AgentRegistry,
    AgentType,
    AgentWorkflow,
    CodeAgent,
    GeneralAgent,
    SingleRCAAgent,
    WorkflowContext,
)
from rest.agent.router import ChatRouter
from rest.typing import ChatMode


async def main():
    """Demonstrate the agent workflow system."""

    # Initialize agents
    print("=== Initializing Agents ===")
    single_rca_agent = SingleRCAAgent()
    code_agent = CodeAgent()
    general_agent = GeneralAgent()

    # Create router
    openai_key = os.getenv("OPENAI_API_KEY", "fake_key")
    router = ChatRouter(client=AsyncOpenAI(api_key=openai_key))

    # Create registry and register all agents
    print("\n=== Creating Agent Registry ===")
    registry = AgentRegistry()

    registry.register(
        agent_type=AgentType.SINGLE_RCA,
        name="Root Cause Analysis Agent",
        description="Analyzes traces and logs for debugging and root cause analysis",
        handler=single_rca_agent,
        supported_operations=[
            "analyze_trace",
            "debug",
            "find_root_cause",
            "analyze_logs"
        ],
        requires_trace_context=True,
    )
    print(f"✓ Registered: {AgentType.SINGLE_RCA.value}")

    registry.register(
        agent_type=AgentType.CODE,
        name="Code Agent",
        description="Handles GitHub operations (issues, PRs, code changes)",
        handler=code_agent,
        supported_operations=["create_issue",
                              "create_pr",
                              "code_changes"],
        requires_github_token=True,
    )
    print(f"✓ Registered: {AgentType.CODE.value}")

    registry.register(
        agent_type=AgentType.GENERAL,
        name="General Agent",
        description="Handles general queries and conversations",
        handler=general_agent,
        supported_operations=["answer_questions",
                              "chat",
                              "general_knowledge"],
    )
    print(f"✓ Registered: {AgentType.GENERAL.value}")

    # Create workflow
    print("\n=== Creating Agent Workflow ===")
    workflow = AgentWorkflow(registry=registry, router=router)

    # Example 1: GitHub PR query → Code Agent
    print("\n" + "=" * 60)
    print("Example 1: GitHub PR Creation Query")
    print("=" * 60)

    context1 = WorkflowContext(
        user_message="Create a pull request to fix the authentication bug",
        chat_mode=ChatMode.AGENT,
        has_trace_context=True,
        is_github_pr=True,
        is_github_issue=False,
        source_code_related=True,
        model="gpt-4o",
    )

    result1 = await workflow.route(context1)
    print(f"User Query: '{context1.user_message}'")
    print(f"Routed To: {result1.agent_metadata.name}")
    print(f"Agent Type: {result1.agent_type.value}")
    print(f"Reasoning: {result1.reasoning}")
    print(
        f"Supported Operations: {', '.join(result1.agent_metadata.supported_operations)}"
    )

    # Example 2: Trace analysis query → Single RCA Agent
    print("\n" + "=" * 60)
    print("Example 2: Trace Analysis Query")
    print("=" * 60)

    context2 = WorkflowContext(
        user_message="What caused the error in this trace?",
        chat_mode=ChatMode.CHAT,
        has_trace_context=True,
        is_github_pr=False,
        is_github_issue=False,
        source_code_related=False,
        model="gpt-4o",
    )

    result2 = await workflow.route(context2)
    print(f"User Query: '{context2.user_message}'")
    print(f"Routed To: {result2.agent_metadata.name}")
    print(f"Agent Type: {result2.agent_type.value}")
    print(f"Reasoning: {result2.reasoning}")
    print(f"Requires Trace Context: {result2.agent_metadata.requires_trace_context}")

    # Example 3: General query → General Agent
    print("\n" + "=" * 60)
    print("Example 3: General Knowledge Query")
    print("=" * 60)

    context3 = WorkflowContext(
        user_message="What is Python?",
        chat_mode=ChatMode.CHAT,
        has_trace_context=False,
        is_github_pr=False,
        is_github_issue=False,
        source_code_related=False,
        model="gpt-4o",
    )

    result3 = await workflow.route(context3)
    print(f"User Query: '{context3.user_message}'")
    print(f"Routed To: {result3.agent_metadata.name}")
    print(f"Agent Type: {result3.agent_type.value}")
    print(f"Reasoning: {result3.reasoning}")

    # Example 4: GitHub issue query → Code Agent
    print("\n" + "=" * 60)
    print("Example 4: GitHub Issue Creation Query")
    print("=" * 60)

    context4 = WorkflowContext(
        user_message="Create an issue to track this bug",
        chat_mode=ChatMode.AGENT,
        has_trace_context=True,
        is_github_pr=False,
        is_github_issue=True,
        source_code_related=True,
        model="gpt-4o",
    )

    result4 = await workflow.route(context4)
    print(f"User Query: '{context4.user_message}'")
    print(f"Routed To: {result4.agent_metadata.name}")
    print(f"Agent Type: {result4.agent_type.value}")
    print(f"Reasoning: {result4.reasoning}")
    print(f"Requires GitHub Token: {result4.agent_metadata.requires_github_token}")

    # List all available agents
    print("\n" + "=" * 60)
    print("All Registered Agents")
    print("=" * 60)

    for agent_metadata in registry.list_all():
        print(f"\n{agent_metadata.name} ({agent_metadata.agent_type.value})")
        print(f"  Description: {agent_metadata.description}")
        print(f"  Operations: {', '.join(agent_metadata.supported_operations)}")
        if agent_metadata.requires_trace_context:
            print("  ⚠ Requires trace context")
        if agent_metadata.requires_github_token:
            print("  ⚠ Requires GitHub token")

    print("\n" + "=" * 60)
    print("Workflow Examples Complete!")
    print("=" * 60)


if __name__ == "__main__":
    asyncio.run(main())
