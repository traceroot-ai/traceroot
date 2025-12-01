from typing import Literal

from openai import AsyncOpenAI
from pydantic import BaseModel, Field

from rest.agent.prompts import ROUTER_SYSTEM_PROMPT
from rest.agent.utils.openai_tools import get_openai_tool_schema
from rest.rest_types import ChatMode
from rest.utils.token_tracking import track_tokens_for_user


class RouterOutput(BaseModel):
    """Output structure for the chat router."""

    agent_type: Literal["single_rca",
                        "code",
                        "general"] = Field(
                            description=(
                                "Which agent to use:\n"
                                "- 'single_rca': For RCA/diagnostic chat "
                                "queries about traces and logs\n"
                                "- 'code': For GitHub or code related operations "
                                "(issues, PRs, code changes)\n"
                                "- 'general': For general queries not related "
                                "to debugging or GitHub or code"
                            )
                        )
    reasoning: str = Field(
        description="Brief explanation (1-2 sentences) of why this agent was selected"
    )


class ChatRouter:
    """
    Router that analyzes user queries and decides which agent should handle them.
    Uses OpenAI structured output to make routing decisions.
    """

    def __init__(self, client: AsyncOpenAI = None):
        """
        Initialize the chat router.

        Args:
            client: AsyncOpenAI client (optional, will create default if not provided)
        """
        self.client = client
        self.system_prompt = ROUTER_SYSTEM_PROMPT

    async def route_query(
        self,
        user_message: str,
        chat_mode: ChatMode,
        model: str = "gpt-4o",
        user_sub: str | None = None,
        openai_token: str | None = None,
        has_trace_context: bool = False,
        is_github_issue: bool = False,
        is_github_pr: bool = False,
        source_code_related: bool = False,
    ) -> RouterOutput:
        """
        Route a user query to the appropriate agent.

        Args:
            user_message: The user's question or request
            chat_mode: Current chat mode (AGENT or CHAT)
            model: OpenAI model to use for routing decision
            user_sub: User subscription ID for token tracking
            openai_token: Optional OpenAI token override
            has_trace_context: Whether trace/log context is available
            is_github_issue: Whether GitHub issue creation was detected
            is_github_pr: Whether GitHub PR creation was detected
            source_code_related: Whether query is source code related

        Returns:
            RouterOutput with agent_type and reasoning
        """
        # Use provided token or fall back to default client
        if openai_token:
            client = AsyncOpenAI(api_key=openai_token)
        elif self.client:
            client = self.client
        else:
            # Fallback: use default behavior based on chat_mode
            # This shouldn't happen in production but provides safety
            if chat_mode == ChatMode.AGENT:
                return RouterOutput(
                    agent_type="code",
                    reasoning="Defaulted to code agent based on AGENT mode"
                )
            else:
                return RouterOutput(
                    agent_type="single_rca",
                    reasoning="Defaulted to single_rca agent based on CHAT mode"
                )

        # Determine allowed agents based on chat mode
        # CHAT mode: only single_rca and general (no code/GitHub operations)
        # AGENT mode: all three agents (single_rca, code, general)
        if chat_mode == ChatMode.CHAT:
            allowed_agents_description = (
                "Available agents for CHAT mode:\n"
                "- 'single_rca': For RCA/diagnostic queries about traces and logs\n"
                "- 'general': For general queries not related to debugging\n"
                "NOTE: 'code' agent is NOT available in CHAT mode"
            )

            # Create a specialized routing function for CHAT mode
            def route_to_agent_chat_mode(
                agent_type: Literal["single_rca",
                                    "general"],
                reasoning: str
            ) -> dict:
                return {"agent_type": agent_type, "reasoning": reasoning}

            routing_function = route_to_agent_chat_mode
        else:  # AGENT mode
            allowed_agents_description = (
                "Available agents for AGENT mode:\n"
                "- 'single_rca': For RCA/diagnostic queries about traces and logs\n"
                "- 'code': For GitHub operations (issues, PRs, code changes)\n"
                "- 'general': For general queries not related to debugging or GitHub"
            )
            routing_function = self._route_to_agent

        # Prepare the routing request
        kwargs = {
            "model":
            model,
            "messages": [
                {
                    "role": "system",
                    "content": self.system_prompt
                },
                {
                    "role":
                    "user",
                    "content": (
                        f"User message: {user_message}\n\n"
                        f"Current chat mode: {chat_mode.value}\n\n"
                        f"Context information:\n"
                        f"- Has trace/logs available: {has_trace_context}\n"
                        f"- GitHub issue creation detected: {is_github_issue}\n"
                        f"- GitHub PR creation detected: {is_github_pr}\n"
                        f"- Source code related: {source_code_related}\n\n"
                        f"{allowed_agents_description}\n\n"
                        "Which agent should handle this query?"
                    )
                },
            ],
            "tools": [get_openai_tool_schema(routing_function)],
        }

        # Set temperature for non-thinking models
        if 'gpt' in model and 'o' not in model.split('-')[0]:
            kwargs["temperature"] = 0.3

        try:
            response = await client.chat.completions.create(**kwargs)

            # Track token usage
            if user_sub:
                await track_tokens_for_user(
                    user_sub=user_sub,
                    openai_response=response,
                    model=model
                )

            # Extract the tool call response
            tool_calls = response.choices[0].message.tool_calls
            if tool_calls and len(tool_calls) > 0:
                import json
                arguments = json.loads(tool_calls[0].function.arguments)
                router_output = RouterOutput(**arguments)

                # Validate the agent type against chat mode
                if chat_mode == ChatMode.CHAT and router_output.agent_type == "code":
                    # Code agent not allowed in CHAT mode, fallback to single_rca
                    print(
                        f"Warning: Router returned 'code' agent in CHAT mode. "
                        f"Falling back to 'single_rca'. Original reasoning: "
                        f"{router_output.reasoning}"
                    )
                    return RouterOutput(
                        agent_type="single_rca",
                        reasoning=(
                            f"Corrected from 'code' to 'single_rca' "
                            f"(code agent not allowed in CHAT mode). "
                            f"Original: {router_output.reasoning}"
                        )
                    )

                return router_output
            else:
                # No tool call - fallback based on mode
                if chat_mode == ChatMode.AGENT:
                    return RouterOutput(
                        agent_type="code",
                        reasoning="No structured response, defaulted based on AGENT mode"
                    )
                else:
                    return RouterOutput(
                        agent_type="single_rca",
                        reasoning="No structured response, defaulted based on CHAT mode"
                    )

        except Exception as e:
            print(f"Error in route_query: {e}")
            # Fallback to safe default based on mode
            if chat_mode == ChatMode.AGENT:
                return RouterOutput(
                    agent_type="code",
                    reasoning=f"Error during routing, defaulted to code agent: {str(e)}"
                )
            else:
                return RouterOutput(
                    agent_type="single_rca",
                    reasoning=(
                        f"Error during routing, defaulted to single_rca agent: "
                        f"{str(e)}"
                    )
                )

    def _route_to_agent(
        self,
        agent_type: Literal["single_rca",
                            "code",
                            "general"],
        reasoning: str
    ) -> dict:
        """
        Internal function schema for OpenAI tool calling.
        This defines the structure for the routing decision.

        Args:
            agent_type: Which agent to use ('single_rca', 'code', or 'general')
            reasoning: Brief explanation of why this agent was selected (required)

        Returns:
            Dictionary with agent_type and reasoning
        """
        return {"agent_type": agent_type, "reasoning": reasoning}
