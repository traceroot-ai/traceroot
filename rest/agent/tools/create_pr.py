from typing import Any

from ..github_tools import CreatePRWithFileChangesInput
from .tool import Tool


class CreatePRTool(Tool):
    """Create a PR with file changes."""

    @property
    def name(self) -> str:

        return "create_pr_with_file_changes"

    @property
    def description(self) -> str:
        return self.__doc__ or "A tool to create a pull request with file changes."

    def run(
        self,
        title: str,
        body: str,
        owner: str,
        repo_name: str,
        base_branch: str,
        head_branch: str,
        file_path_to_change: str,
        file_content_to_change: str,
        commit_message: str,
    ) -> dict[str,
              Any]:
        """
        This is where the core logic from the old function goes.
        It takes the same arguments and returns the Pydantic object
        as a dictionary.
        """
        pr_input = CreatePRWithFileChangesInput(
            title=title,
            body=body,
            owner=owner,
            repo_name=repo_name,
            base_branch=base_branch,
            head_branch=head_branch,
            file_path_to_change=file_path_to_change,
            file_content_to_change=file_content_to_change,
            commit_message=commit_message,
        )

        return pr_input.model_dump()
