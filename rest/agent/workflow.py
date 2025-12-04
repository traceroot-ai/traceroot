"""Agent workflow system for routing queries to specialized subagents.

This module provides a workflow framework for redirecting user queries
to appropriate specialized agents based on query context and intent.
"""

from dataclasses import dataclass
from enum import Enum
from typing import Any, Callable, Protocol

from rest.agent.router import ChatRouter, RouterOutput
from rest.typing import ChatMode


class AgentType(str, Enum):
    """Types of agents available in the system."""

    SINGLE_RCA = "single_rca"
    CODE = "code"
    GENERAL = "general"


@dataclass
class AgentMetadata:
    """Metadata for an agent registration."""

    agent_type: AgentType
    name: str
    description: str
    handler: Any  # The actual agent instance (SingleRCAAgent, CodeAgent, etc.)
    supported_operations: list[str]
    requires_trace_context: bool = False
    requires_github_token: bool = False


class AgentProtocol(Protocol):
    """Protocol that all agents must implement."""

    async def chat(self, *args, **kwargs) -> Any:
        """Chat interface that all agents must implement."""
        ...


class AgentRegistry:
    """Registry for managing available agents in the system.

    This registry maintains a mapping of agent types to their implementations,
    making it easy to add new agents and query available agents.
    """

    def __init__(self):
        """Initialize the agent registry."""
        self._agents: dict[AgentType, AgentMetadata] = {}

    def register(
        self,
        agent_type: AgentType,
        name: str,
        description: str,
        handler: AgentProtocol,
        supported_operations: list[str],
        requires_trace_context: bool = False,
        requires_github_token: bool = False,
    ) -> None:
        """Register a new agent in the registry.

        Args:
            agent_type: The type of agent
            name: Human-readable name for the agent
            description: Description of what the agent does
            handler: The agent instance
            supported_operations: List of operations this agent supports
            requires_trace_context: Whether the agent requires trace/log context
            requires_github_token: Whether the agent requires a GitHub token
        """
        metadata = AgentMetadata(
            agent_type=agent_type,
            name=name,
            description=description,
            handler=handler,
            supported_operations=supported_operations,
            requires_trace_context=requires_trace_context,
            requires_github_token=requires_github_token,
        )
        self._agents[agent_type] = metadata

    def get(self, agent_type: AgentType) -> AgentMetadata | None:
        """Get an agent by type.

        Args:
            agent_type: The type of agent to retrieve

        Returns:
            Agent metadata if found, None otherwise
        """
        return self._agents.get(agent_type)

    def list_all(self) -> list[AgentMetadata]:
        """List all registered agents.

        Returns:
            List of all agent metadata
        """
        return list(self._agents.values())

    def get_handler(self, agent_type: AgentType) -> AgentProtocol | None:
        """Get the handler for a specific agent type.

        Args:
            agent_type: The type of agent

        Returns:
            The agent handler instance if found, None otherwise
        """
        metadata = self.get(agent_type)
        return metadata.handler if metadata else None


@dataclass
class WorkflowContext:
    """Context information for routing decisions.

    This encapsulates all the information needed to make intelligent
    routing decisions.
    """

    user_message: str
    chat_mode: ChatMode
    has_trace_context: bool
    is_github_issue: bool
    is_github_pr: bool
    source_code_related: bool
    model: str = "gpt-4o"
    user_sub: str | None = None
    openai_token: str | None = None


@dataclass
class WorkflowResult:
    """Result of a workflow routing decision.

    Contains both the routing decision and metadata about why that
    decision was made.
    """

    agent_type: AgentType
    agent_metadata: AgentMetadata
    reasoning: str
    router_output: RouterOutput


class AgentWorkflow:
    """Workflow manager for redirecting queries to specialized subagents.

    This class implements the workflow described in issue #85:
    "A workflow to redirect to some agents" - for example, if the query
    is related to GitHub PR, redirect to the GitHub subagent (CodeAgent).

    The workflow:
    1. Analyze the user query and context
    2. Use the ChatRouter to determine the appropriate agent
    3. Look up the agent in the registry
    4. Return the agent and routing metadata

    Example:
        >>> workflow = AgentWorkflow(registry, router)
        >>> context = WorkflowContext(
        ...     user_message="Create a PR to fix this bug",
        ...     chat_mode=ChatMode.AGENT,
        ...     has_trace_context=True,
        ...     is_github_pr=True,
        ...     ...
        ... )
        >>> result = await workflow.route(context)
        >>> agent = result.agent_metadata.handler
        >>> # Now call the agent's chat method
        >>> response = await agent.chat(...)
    """

    def __init__(self, registry: AgentRegistry, router: ChatRouter):
        """Initialize the workflow manager.

        Args:
            registry: The agent registry containing all available agents
            router: The chat router for making routing decisions
        """
        self.registry = registry
        self.router = router

    async def route(self, context: WorkflowContext) -> WorkflowResult:
        """Route a query to the appropriate agent.

        This is the main workflow method that:
        1. Uses the router to analyze the query
        2. Looks up the appropriate agent from the registry
        3. Returns the agent handler and metadata

        Args:
            context: The workflow context containing query and metadata

        Returns:
            WorkflowResult containing the agent to use and routing metadata

        Raises:
            ValueError: If the routed agent type is not registered
        """
        # Step 1: Use router to determine which agent should handle this
        router_output = await self.router.route_query(
            user_message=context.user_message,
            chat_mode=context.chat_mode,
            model=context.model,
            user_sub=context.user_sub,
            openai_token=context.openai_token,
            has_trace_context=context.has_trace_context,
            is_github_issue=context.is_github_issue,
            is_github_pr=context.is_github_pr,
            source_code_related=context.source_code_related,
        )

        # Step 2: Convert router output to AgentType
        agent_type = AgentType(router_output.agent_type)

        # Step 3: Look up the agent in the registry
        agent_metadata = self.registry.get(agent_type)
        if not agent_metadata:
            raise ValueError(
                f"Agent type '{agent_type}' not found in registry. "
                f"Available agents: {[a.agent_type for a in self.registry.list_all()]}"
            )

        # Step 4: Return the workflow result
        return WorkflowResult(
            agent_type=agent_type,
            agent_metadata=agent_metadata,
            reasoning=router_output.reasoning,
            router_output=router_output,
        )

    def validate_context(self,
                         context: WorkflowContext,
                         agent_metadata: AgentMetadata) -> tuple[bool,
                                                                 str | None]:
        """Validate that the context meets the agent's requirements.

        Args:
            context: The workflow context
            agent_metadata: The agent metadata

        Returns:
            Tuple of (is_valid, error_message)
            If valid, error_message is None
        """
        # Check if agent requires trace context
        if agent_metadata.requires_trace_context and not context.has_trace_context:
            return False, (
                f"{agent_metadata.name} requires trace/log context, "
                "but none is available"
            )

        # Add more validation as needed

        return True, None
