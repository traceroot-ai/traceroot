import asyncio
import uuid
from typing import Any

from github import Github, GithubException


class GitHubClient:

    def __init__(self):
        """Initialize GitHub client with token from environment variable."""

    async def create_issue(
        self,
        title: str,
        body: str,
        owner: str,
        repo_name: str,
        github_token: str | None = None,
    ) -> int:
        r"""Create an issue.
        """

        def _create_issue() -> int:
            if github_token:
                github = Github(github_token, retry=None)
            else:
                github = Github(retry=None)
            repo = github.get_repo(f"{owner}/{repo_name}")
            issue = repo.create_issue(title=title, body=body)
            return issue.number

        loop = asyncio.get_event_loop()
        return await loop.run_in_executor(None, _create_issue)

    async def create_pr_with_file_changes(
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

        def _create_pr() -> int:
            if github_token:
                github = Github(github_token, retry=None)
            else:
                github = Github(retry=None)
            repo = github.get_repo(f"{owner}/{repo_name}")

            base_ref = repo.get_git_ref(f"heads/{base_branch}")
            base_sha = base_ref.object.sha

            # Create a new branch, add UUID suffix to avoid conflicts
            unique_head_branch = f"{head_branch}-{uuid.uuid4().hex[:8]}"
            repo.create_git_ref(ref=f"refs/heads/{unique_head_branch}", sha=base_sha)

            # Get the current file to update
            try:
                file_obj = repo.get_contents(file_path_to_change, ref=base_branch)
                repo.update_file(
                    path=file_path_to_change,
                    message=commit_message,
                    content=file_content_to_change,
                    sha=file_obj.sha,
                    branch=unique_head_branch,
                )
            except GithubException as e:
                if e.status == 404:  # File doesn't exist, create it
                    repo.create_file(
                        path=file_path_to_change,
                        message=commit_message,
                        content=file_content_to_change,
                        branch=unique_head_branch,
                    )
                else:
                    raise e

            # Create a pull request
            pr = repo.create_pull(
                title=title,
                body=body,
                base=base_branch,
                head=unique_head_branch,
            )

            print(f"PR created: {pr.html_url}")
            return pr.number

        loop = asyncio.get_event_loop()
        return await loop.run_in_executor(None, _create_pr)

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

    async def get_file_with_context(
        self,
        owner: str,
        repo: str,
        file_path: str,
        ref: str,
        line_num: int,
        github_token: str | None,
        cache: Any,  # Cache type from rest.cache
        line_context_len: int = 100,
    ) -> dict[str, Any]:
        """Get file line with context, using cache for optimization.

        This method handles the complete flow of fetching a file from GitHub
        with caching at two levels:
        1. Context cache: Caches the specific line context for a line number
        2. File cache: Caches the entire file content

        Args:
            owner: Repository owner
            repo: Repository name
            file_path: Path to the file in the repository
            ref: Branch / commit hash
            line_num: Line number to retrieve (1-based indexing)
            github_token: GitHub token for authentication
            cache: Cache instance (from rest.cache.Cache)
            line_context_len: Number of lines of context to retrieve above and below

        Returns:
            Dictionary containing line, lines_above, lines_below, and error_message
            (matches CodeResponse.model_dump() format)
        """
        # Import here to avoid circular dependency
        from rest.cache import CacheType
        from rest.config import CodeResponse

        context_key = (owner, repo, file_path, ref, line_num)
        # Try to get cached context lines
        context_lines = await cache[CacheType.GITHUB].get(context_key)

        # Cache hit for context
        if context_lines is not None:
            lines_above, line, lines_below = context_lines
            response = CodeResponse(
                line=line,
                lines_above=lines_above,
                lines_below=lines_below,
            )
            return response.model_dump()

        # Cache miss for context, check file content cache
        file_key = (owner, repo, file_path, ref)
        file_content = await cache[CacheType.GITHUB].get(file_key)

        # File content is cached, get context lines from file content
        if file_content is not None:
            context_lines = await self.get_line_context_content(file_content, line_num)
            # Cache the context lines
            await cache[CacheType.GITHUB].set(context_key, context_lines)
            if context_lines is not None:
                lines_above, line, lines_below = context_lines
                response = CodeResponse(
                    line=line,
                    lines_above=lines_above,
                    lines_below=lines_below,
                )
                return response.model_dump()

        # File content is not cached, need to fetch from GitHub
        file_content, error_message = await self.get_file_content(
            owner, repo, file_path, ref, github_token)

        # If file content is not found or cannot be retrieved,
        # return the error message
        if file_content is None:
            response = CodeResponse(
                line=None,
                lines_above=None,
                lines_below=None,
                error_message=error_message,
            )
            return response.model_dump()

        # Cache the file content
        await cache[CacheType.GITHUB].set(file_key, file_content)
        context_lines = await self.get_line_context_content(
            file_content,
            line_num,
            line_context_len=line_context_len,
        )
        if context_lines is None:
            error_message = (
                f"Failed to get line context content "
                f"for line number {line_num} "
                f"in {owner}/{repo}@{ref}"
            )
            response = CodeResponse(
                line=None,
                lines_above=None,
                lines_below=None,
                error_message=error_message,
            )
            return response.model_dump()

        # Cache the context lines
        await cache[CacheType.GITHUB].set(context_key, context_lines)
        lines_above, line, lines_below = context_lines
        response = CodeResponse(
            line=line,
            lines_above=lines_above,
            lines_below=lines_below,
        )
        return response.model_dump()
