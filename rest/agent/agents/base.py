from abc import ABC, abstractmethod
from typing import Any, Callable


class AgentTool:
    """Represents a tool that an agent can use.

    Attributes:
        name (str): The name of the tool
        function (Callable): The callable function that implements the tool
        parameters (dict[str, Any] | None): Dictionary describing the parameters the tool accepts
        description (str | None): Description of what the tool does
    """

    def __init__(
        self,
        name: str,
        function: Callable,
        parameters: dict[str,
                         Any] | None = None,
        description: str | None = None
    ):
        self.name = name
        self.function = function
        self.parameters = parameters or {}
        self.description = description or ""

    def __repr__(self) -> str:
        return f"AgentTool(name='{self.name}', description='{self.description}')"


class BaseAgent(ABC):
    """Abstract base class for all agents.

    An agent should include:
    - A run function for executing workflows
    - A model specification enabling workflow execution
    - A set of tools (each with a function and parameter set)

    Attributes:
        name: The name of the agent
        model: The model specification for the agent (e.g., "gpt-4", "claude-3")
        tools: List of AgentTool objects available to the agent
    """

    def __init__(self):
        """Initialize a base agent with default values."""
        self.name = ""
        self.model = None
        self.tools: list[AgentTool] = []

    @abstractmethod
    async def chat(self, *args, **kwargs):
        """Common chat interface that all agents must implement.

        Each agent can have different parameters and return types
        based on their specific use case.
        """

    async def run(self, *args, **kwargs) -> Any:
        """Execute the agent's workflow.

        This method provides a unified interface for executing
        agent workflows. By default, it delegates to the chat method,
        but subclasses can override this to implement custom workflows.

        Returns:
            The result of the workflow execution
        """
        return await self.chat(*args, **kwargs)

    def add_tool(self, tool: AgentTool) -> None:
        """Add a tool to the agent's toolset.

        Args:
            tool: The AgentTool object to add
        """
        self.tools.append(tool)

    def get_tool(self, name: str) -> AgentTool | None:
        """Get a tool by name.

        Args:
            name: The name of the tool to retrieve

        Returns:
            The AgentTool object if found, None otherwise
        """
        for tool in self.tools:
            if tool.name == name:
                return tool
        return None

    def list_tools(self) -> list[str]:
        """List all available tool names.

        Returns:
            List of tool names
        """
        return [tool.name for tool in self.tools]
