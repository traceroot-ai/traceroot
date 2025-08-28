# abstract class of tool
from abc import ABC, abstractmethod
from typing import Any, Callable


class Tool(ABC):

    def __init__(self, **kwargs) -> None:
        self.tool: Callable

        self.name = ""
        self.description = ""
        self.parameters = {}

        # arguments should pass to run
        self.arguments = {}
        self.values = {}

    def get_name(self) -> str:
        """
            get tool name
        """
        return self.name

    @abstractmethod
    def run(self) -> dict[str, Any]:
        pass

    @abstractmethod
    def get_parameters(self) -> dict[str, Any]:
        pass

    def get_description(self):
        return self.description
