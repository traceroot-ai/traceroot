from abc import ABC, abstractmethod


class BaseAgent(ABC):

    def __init__(self):
        """
            An agent abstraction class
        """
        self.name = ""
        self.tools = []

    @abstractmethod
    async def chat(self, *args, **kwargs):
        """
        Common chat interface that all agents must implement.
        Each agent can have different parameters and return types.
        """

    def get_context_messages(self, context: str) -> list[str]:
        """
        Get the context message(s).
        This is a common method used by both SingleRCAAgent and CodeAgent.

        Args:
            context (str): The context to be chunked

        Returns:
            list[str]: List of context message chunks
        """
        from rest.agent.chunk.sequential import sequential_chunk

        context_chunks = list(sequential_chunk(context))
        if len(context_chunks) == 1:
            return [
                (
                    f"\n\nHere is the structure of the tree with related "
                    "information:\n\n"
                    f"{context}"
                )
            ]
        messages: list[str] = []
        for i, chunk in enumerate(context_chunks):
            messages.append(
                f"\n\nHere is the structure of the tree "
                f"with related information of the "
                f"{i + 1}th chunk of the tree:\n\n"
                f"{chunk}"
            )
        return messages
