# abstract class of tool
from abc import ABC, abstractmethod
from typing import Callable


class Tool(ABC):

    def __init__(self, ) -> None:
        self.tool: Callable
        self.description = ""
        self.parameters = {}

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
