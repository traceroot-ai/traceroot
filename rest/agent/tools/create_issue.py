from typing import Any

from ..github_tools import CreateIssueInput
from .tool import Tool


class CreateIssueTool(Tool):
    """Create a GitHub issue."""

    @property
    def name(self) -> str:
        """This name must match the old function name for the agent to use it"""
        return "create_issue"

    @property
    def description(self) -> str:
        """The description is taken from the class docstring"""
        return self.__doc__ or "A tool to create a GitHub issue."

    def run(self, title: str, body: str, owner: str, repo_name: str) -> dict[str, Any]:
        """
        This is where the core logic from the old function goes.
        It takes the same arguments and returns the Pydantic object
        as a dictionary.
        """
        issue_input = CreateIssueInput(
            title=title,
            body=body,
            owner=owner,
            repo_name=repo_name,
        )
        """ The .model_dump() method converts the Pydantic object to a dictionary"""
        return issue_input.model_dump()
