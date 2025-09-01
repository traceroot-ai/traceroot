from typing import Any

from rest.agent.tools.tool import Tool
from rest.client.github_client import GitHubClient
from rest.typing import ActionType


class CreateGitIssue(Tool):

    def __init__(self, **kwargs) -> None:

        self.name = "CreateGitIssue"

        self.description = """
            This tool helps you to create a github issue.
        """
        self.github_token = kwargs.get("github_token", None)

        if not self.github_token:
            raise Exception("No Github token is set, can not create issues.")

    def run(self) -> dict[str, Any]:
        github_client = GitHubClient()

        issue_number = github_client.create_issue(
            title=self.values['title'],
            body=self.values['body'],
            owner=self.values['owner'],
            repo_name=self.values['repo_name'],
            github_token=self.github_token
        )

        url = (
            f"https://github.com/{self.values['owner']}/"
            f"{self.values['repo_name']}/"
            f"issues/{issue_number}"
        )

        content = f"Issue created: {url}"
        action_type = ActionType.GITHUB_CREATE_ISSUE.value

        return {"content": content, "action_type": action_type}

    def get_parameters(self) -> dict[str, Any]:
        self.parameters["body"] = {"type": str, "description": "The body of the issue."}

        self.parameters["title"] = {"type": str, "description": "The title of the issue."}

        self.parameters["owner"] = {
            "type": str,
            "description": "The owner of the repository."
        }

        self.parameters["repo_name"] = {
            "type": str,
            "description": "The name of the repository."
        }

        # this is design for later support of different model
        # as diffeerent model handle tools in a different
        # manner
        return self.parameters


# create issue function shall place here ?
