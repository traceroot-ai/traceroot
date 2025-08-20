# abstract class of tool
from abc import ABC, abstractmethod
from typing import Any, Callable


class Tool(ABC):

    def __init__(
        self,
        func: Callable,
        description: str,
        parameters: dict[str,
                         Any]
    ) -> None:
        self.tool = func
        self.description = description
        self.parameters = parameters

        # arguments should pass to run
        self.arguments = {}

    @abstractmethod
    def run(self):
        pass

    @abstractmethod
    def get_parameters(self):
        pass

    def get_description(self):
        return self.description
