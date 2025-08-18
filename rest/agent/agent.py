# Please use our cloud if you want to use full agent functionalities :)

from datetime import datetime

try:
    from rest.client.ee.mongodb_client import TraceRootMongoDBClient
except ImportError:
    from rest.client.mongodb_client import TraceRootMongoDBClient

from rest.agent.context.tree import SpanNode
from rest.config import ChatbotResponse
from rest.typing import ChatModel, Provider


class Agent:

    def __init__(self):
        pass

    async def chat(
        self,
        trace_id: str,
        chat_id: str,
        user_message: str,
        model: ChatModel,
        db_client: TraceRootMongoDBClient,
        timestamp: datetime,
        tree: SpanNode,
        user_sub: str,
        chat_history: list[dict] | None = None,
        openai_token: str | None = None,
        github_token: str | None = None,
        github_file_tasks: set[tuple[str, str, str, str]] | None = None,
        is_github_issue: bool = False,
        is_github_pr: bool = False,
        provider: Provider | None = None,
        groq_token: str | None = None,
    ) -> ChatbotResponse:
        pass
