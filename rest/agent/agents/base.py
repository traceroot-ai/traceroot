from abc import ABC, abstractmethod


class Agent(ABC):

    def __init__(self):
        """
            An agent abstraction class
        """
        self.name = ""
        self.tools = []

        # shall we add model here ?
        # I do think model selection is necessary
        # i.e different providers

    @abstractmethod
    def run(self):
        pass
