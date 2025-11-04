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
