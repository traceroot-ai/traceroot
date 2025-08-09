from pydantic import BaseModel, Field


class CreateIssueInput(BaseModel):
    r"""Create issue output.
    """
    body: str = Field(description=("The body of the issue."))
    title: str = Field(description=("The title of the issue."))
    owner: str = Field(description=("The owner of the repository."))
    repo_name: str = Field(description=("The name of the repository."))


class CreatePRWithFileChangesInput(BaseModel):
    r"""Create PR with file changes output.
    """
    title: str = Field(description=("The title of the PR. Please make sure "
                                    "the title is concise and to the point."))
    body: str = Field(description=("The body of the PR. Please make sure "
                                   "the body is concise and to the point."))
    owner: str = Field(description=("The owner of the repository."))
    repo_name: str = Field(description=("The name of the repository."))
    base_branch: str = Field(description=("The base branch of the PR."))
    head_branch: str = Field(description=("The head branch of the PR."))
    file_path_to_change: str = Field(description=("The file path to change."))
    file_content_to_change: str = Field(
        description=("The content that you want "
                     "to change to that file."))
    commit_message: str = Field(description=("The commit message of the PR. "
                                             "Please make sure the commit "
                                             "message is concise and to the "
                                             "point."))


def create_issue(
    title: str,
    body: str,
    owner: str,
    repo_name: str,
) -> CreateIssueInput:
    r"""Create an issue.
    Args:
        title (str): The title of the issue.
        body (str): The body of the issue.
        owner (str): The owner of the repository.
        repo_name (str): The name of the repository.

    Returns:
        CreateIssueInput: The input of the issue creation.
    """
    return CreateIssueInput(
        title=title,
        body=body,
        owner=owner,
        repo_name=repo_name,
    )


def create_pr_with_file_changes(
    title: str,
    body: str,
    owner: str,
    repo_name: str,
    base_branch: str,
    head_branch: str,
    file_path_to_change: str,
    file_content_to_change: str,
    commit_message: str,
) -> CreatePRWithFileChangesInput:
    r"""Create a PR with file changes.
    Args:
        title (str): The title of the PR.
        body (str): The body of the PR.
        owner (str): The owner of the repository.
        repo_name (str): The name of the repository.
        base_branch (str): The base branch of the PR. If you are not sure,
            please put "main" as the base branch.
        head_branch (str): The head branch of the PR.
        file_path_to_change (str): The file path to change.
        file_content_to_change (str): The content that you want to change to
            that file.
        commit_message (str): The commit message of the PR.

    Returns:
        CreatePRWithFileChangesInput: The input of the PR creation with file
            changes.
    """
    return CreatePRWithFileChangesInput(
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
