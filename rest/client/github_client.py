import asyncio

from github import Github, GithubException


class GitHubClient:

    def __init__(self):
        """Initialize GitHub client with token from environment variable."""

    def create_issue(
        self,
        title: str,
        body: str,
        owner: str,
        repo_name: str,
        github_token: str | None = None,
    ) -> int:
        r"""Create an issue.
        """
        if github_token:
            github = Github(github_token, retry=None)
        else:
            github = Github(retry=None)
        repo = github.get_repo(f"{owner}/{repo_name}")
        issue = repo.create_issue(title=title, body=body)
        return issue.number

    def create_pr_with_file_changes(
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
        github_token: str | None = None,
    ) -> int:
        r"""Create a PR with file changes.
        """
        if github_token:
            github = Github(github_token, retry=None)
        else:
            github = Github(retry=None)
        repo = github.get_repo(f"{owner}/{repo_name}")

        base_ref = repo.get_git_ref(f"heads/{base_branch}")
        base_sha = base_ref.object.sha

        # Create the new head branch
        try:
            repo.create_git_ref(f"refs/heads/{head_branch}", base_sha)
        except Exception as e:
            if "Reference already exists" in str(e):
                # Branch already exists, update it to point to base
                head_ref = repo.get_git_ref(f"heads/{head_branch}")
                head_ref.edit(base_sha)
            else:
                raise e

        try:
            # Try to get existing file
            file_content = repo.get_contents(file_path_to_change, ref=head_branch)
            # Update existing file
            repo.update_file(
                path=file_path_to_change,
                message=commit_message,
                content=file_content_to_change,
                sha=file_content.sha,
                branch=head_branch
            )
        except Exception:
            # File doesn't exist, create new file
            repo.create_file(
                path=file_path_to_change,
                message=commit_message,
                content=file_content_to_change,
                branch=head_branch
            )

        pr = repo.create_pull(
            title=title,
            body=body,
            base=base_branch,
            head=head_branch,
        )
        print(f"PR created: {pr.html_url}")
        return pr.number

    async def get_file_content(
        self,
        owner: str,
        repo_name: str,
        file_path: str,
        ref: str = "main",
        github_token: str | None = None,
    ) -> tuple[list[str] | None,
               str | None]:
        r"""Get file content from a GitHub repository.

        Args:
            owner (str): Repository owner
            repo_name (str): Repository name
            file_path (str): Path to the file in the repository
            ref (str): Branch / commit hash (default: "main")
            github_token (str | None): GitHub token for authentication

        Returns:
            tuple[list[str] | None, str | None]: Tuple containing:
                - List of lines from the file or None if file cannot be
                    retrieved or github is not initialized
                - Error message or None if no error occurred
        """
        print(f"Getting file content for {owner}"
              f"/{repo_name}/{file_path}@{ref}")

        # Set GitHub token if provided
        if github_token:
            github = Github(github_token, retry=None)
        else:
            github = Github(retry=None)

        def _get_content() -> tuple[list[str] | None, str | None]:
            try:
                repo = github.get_repo(f"{owner}/{repo_name}")
                file_content = repo.get_contents(file_path, ref=ref)
                content = file_content.decoded_content.decode("utf-8")
                lines = content.splitlines()
                return lines, None
            except GithubException as e:
                if e.status == 401:
                    message = f"GitHub authentication failed (401): {e}"
                elif e.status == 403:
                    # Check if this is a rate limit error
                    if "rate limit" in str(e).lower() or "abuse" in str(e).lower():
                        message = f"GitHub rate limit exceeded (403): {e}"
                    else:
                        message = (
                            f"GitHub access forbidden (403) for repository "
                            f"{owner}/{repo_name}"
                        )
                elif e.status == 404:
                    message = (
                        f"GitHub resource not found (404): Repository "
                        f"{owner}/{repo_name} or file {file_path} not found"
                    )
                else:
                    message = f"GitHub API error ({e.status}): {e}"
                return None, message
            except Exception as e:
                # Handle other exceptions (network errors, etc.)
                message = f"Unexpected error accessing GitHub: {e}"
                return None, message

        loop = asyncio.get_event_loop()
        return await loop.run_in_executor(None, _get_content)

    async def get_line_context_content(
        self,
        lines: list[str],
        line_number: int,
        line_context_len: int = 5,
    ) -> tuple[list[str],
               str,
               list[str]] | None:
        """
        Get specific line content with context from a GitHub repository file.

        Args:
            lines (list[str]): List of lines from the file
            line_number (int): Line number to retrieve (1-based indexing)
            line_context_len (int): Number of lines of context to
                retrieve above and below

        Returns:
            Tuple of (lines_above, line, lines_below) where line is the
                target line, or None if line doesn't exist
        """
        if lines is None:
            return None

        total_lines = len(lines)

        # Check if target line number is valid
        if not (1 <= line_number <= total_lines):
            return None

        # Calculate context range with edge case handling
        start_line = max(1, line_number - line_context_len)  # Don't go below line 1
        end_line = min(
            total_lines,
            line_number + line_context_len
        )  # Don't exceed total lines

        # Extract lines above the target line (convert to 0-based indexing)
        lines_above = lines[start_line - 1:line_number - 1]

        # Extract the target line itself (convert to 0-based indexing)
        line = lines[line_number - 1]

        # Extract lines below the target line (convert to 0-based indexing)
        lines_below = lines[line_number:end_line]

        # Return the tuple of three elements
        return (lines_above, line, lines_below)
