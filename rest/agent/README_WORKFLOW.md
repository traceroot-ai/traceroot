# Agent Workflow System

This document describes the agent workflow system for routing user queries to specialized subagents.

## Overview

The workflow system provides a structured way to redirect queries to appropriate agents based on context and intent. For example, if a query is related to GitHub PR creation, it will be automatically redirected to the Code Agent (GitHub subagent).

## Components

### 1. AgentRegistry

The `AgentRegistry` manages all available agents in the system.

```python
from rest.agent import AgentRegistry, AgentType

# Create a registry
registry = AgentRegistry()

# Register agents
registry.register(
    agent_type=AgentType.SINGLE_RCA,
    name="Root Cause Analysis Agent",
    description="Analyzes traces and logs for debugging",
    handler=single_rca_agent_instance,
    supported_operations=["analyze_trace", "find_errors", "debug"],
    requires_trace_context=True,
)

registry.register(
    agent_type=AgentType.CODE,
    name="Code Agent",
    description="Handles GitHub operations (issues, PRs)",
    handler=code_agent_instance,
    supported_operations=["create_issue", "create_pr", "modify_code"],
    requires_github_token=True,
)

registry.register(
    agent_type=AgentType.GENERAL,
    name="General Agent",
    description="Handles general queries",
    handler=general_agent_instance,
    supported_operations=["answer_questions", "chat"],
)
```

### 2. AgentWorkflow

The `AgentWorkflow` orchestrates the routing logic using the `ChatRouter` and `AgentRegistry`.

```python
from rest.agent import AgentWorkflow, WorkflowContext
from rest.typing import ChatMode

# Create workflow
workflow = AgentWorkflow(registry=registry, router=chat_router)

# Create context for routing
context = WorkflowContext(
    user_message="Create a PR to fix this error",
    chat_mode=ChatMode.AGENT,
    has_trace_context=True,
    is_github_pr=True,
    is_github_issue=False,
    source_code_related=True,
    model="gpt-4o",
    user_sub="user123",
    openai_token="sk-...",
)

# Route the query
result = await workflow.route(context)

# Access the selected agent
agent = result.agent_metadata.handler
print(f"Routing to: {result.agent_metadata.name}")
print(f"Reasoning: {result.reasoning}")

# Use the agent
response = await agent.chat(...)
```

### 3. Workflow Context

The `WorkflowContext` encapsulates all information needed for routing:

- `user_message`: The user's query
- `chat_mode`: CHAT or AGENT mode
- `has_trace_context`: Whether trace/log data is available
- `is_github_issue`: Whether GitHub issue creation was detected
- `is_github_pr`: Whether GitHub PR creation was detected
- `source_code_related`: Whether the query relates to source code
- `model`: The LLM model to use for routing decisions
- `user_sub`: User identifier for token tracking
- `openai_token`: Optional OpenAI API key override

### 4. Workflow Result

The `WorkflowResult` contains:

- `agent_type`: The selected agent type (enum)
- `agent_metadata`: Full metadata about the agent
- `reasoning`: Explanation of why this agent was chosen
- `router_output`: Raw output from the ChatRouter

## Routing Logic

The workflow uses the following logic to route queries:

1. **Priority Rules** (checked first):
   - GitHub issue/PR detected → **Code Agent**
   - Explicit "create issue/PR" in message → **Code Agent**

2. **Context-Based Rules**:
   - Trace context available + diagnostic query → **Single RCA Agent**
   - GitHub operations without trace → **Code Agent**
   - No trace + general question → **General Agent**

3. **Default Behavior**:
   - If unclear + has trace → **Single RCA Agent**
   - If unclear + no trace → **General Agent**

## Integration Example

Here's how to integrate the workflow system into your chat logic:

```python
from rest.agent import (
    AgentRegistry,
    AgentWorkflow,
    AgentType,
    WorkflowContext,
)
from rest.agent.router import ChatRouter

class ChatLogic:
    def __init__(self):
        # Initialize agents
        self.single_rca_agent = SingleRCAAgent()
        self.code_agent = CodeAgent()
        self.general_agent = GeneralAgent()
        self.chat_router = ChatRouter()

        # Create registry and register agents
        self.agent_registry = AgentRegistry()
        self.agent_registry.register(
            agent_type=AgentType.SINGLE_RCA,
            name="Root Cause Analysis Agent",
            description="Analyzes traces and logs for debugging",
            handler=self.single_rca_agent,
            supported_operations=["analyze_trace", "debug", "find_root_cause"],
            requires_trace_context=True,
        )
        self.agent_registry.register(
            agent_type=AgentType.CODE,
            name="Code Agent",
            description="Handles GitHub operations",
            handler=self.code_agent,
            supported_operations=["create_issue", "create_pr", "code_changes"],
            requires_github_token=True,
        )
        self.agent_registry.register(
            agent_type=AgentType.GENERAL,
            name="General Agent",
            description="Handles general queries",
            handler=self.general_agent,
            supported_operations=["answer_questions", "chat"],
        )

        # Create workflow
        self.agent_workflow = AgentWorkflow(
            registry=self.agent_registry,
            router=self.chat_router,
        )

    async def handle_chat(self, user_message: str, **kwargs):
        # Create workflow context
        context = WorkflowContext(
            user_message=user_message,
            chat_mode=kwargs.get("chat_mode"),
            has_trace_context=bool(kwargs.get("trace_id")),
            is_github_issue=kwargs.get("is_github_issue", False),
            is_github_pr=kwargs.get("is_github_pr", False),
            source_code_related=kwargs.get("source_code_related", False),
            model=kwargs.get("model", "gpt-4o"),
            user_sub=kwargs.get("user_sub"),
            openai_token=kwargs.get("openai_token"),
        )

        # Route to appropriate agent
        result = await self.agent_workflow.route(context)

        # Log routing decision
        print(f"[ROUTING] {result.agent_metadata.name}")
        print(f"[REASON] {result.reasoning}")

        # Get the agent handler
        agent = result.agent_metadata.handler

        # Call the agent's chat method
        response = await agent.chat(**kwargs)

        return response
```

## Adding New Agents

To add a new agent to the system:

1. **Create the agent class** (inheriting from BaseAgent if available):
   ```python
   class MyNewAgent(BaseAgent):
       async def chat(self, **kwargs):
           # Implementation
           pass
   ```

2. **Add to AgentType enum** (in `workflow.py`):
   ```python
   class AgentType(str, Enum):
       SINGLE_RCA = "single_rca"
       CODE = "code"
       GENERAL = "general"
       MY_NEW_AGENT = "my_new_agent"  # Add this
   ```

3. **Update the router** (in `router.py` and `router_prompts.py`):
   - Add the new agent type to `RouterOutput`
   - Update `ROUTER_SYSTEM_PROMPT` with description and routing rules

4. **Register the agent**:
   ```python
   registry.register(
       agent_type=AgentType.MY_NEW_AGENT,
       name="My New Agent",
       description="Handles specialized queries",
       handler=my_new_agent_instance,
       supported_operations=["special_operation"],
   )
   ```

## Benefits

1. **Explicit Workflow**: The routing logic is now explicit and documented
2. **Easy Extension**: Adding new agents is straightforward
3. **Type Safety**: Using enums and dataclasses provides type safety
4. **Visibility**: The system provides clear reasoning for routing decisions
5. **Testability**: Components can be tested independently
6. **Registry Pattern**: Centralized management of all available agents

## Migration

The workflow system is **optional** and maintains backward compatibility. Existing code using `ChatRouter` directly will continue to work. The workflow system is a higher-level abstraction built on top of the existing router.
