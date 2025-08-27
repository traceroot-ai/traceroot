import asyncio
import base64
import random
from typing import Optional

import httpx


class GitHubClient:

    def __init__(self, token: str, app_name: str = "my-async-app", timeout: int = 30):
        """Initialize async GitHub client."""
        self.base_url = "https://api.github.com"
        self.headers = {
            "Authorization": f"Bearer {token}",
            "Accept": "application/vnd.github+json",
            "User-Agent": app_name,
        }
        self.client = httpx.AsyncClient(
            base_url=self.base_url,
            headers=self.headers,
            timeout=httpx.Timeout(timeout),
            limits=httpx.Limits(max_connections=20,
                                max_keepalive_connections=10),
        )

    async def _request(self, method: str, url: str, **kwargs) -> dict:
        """Wrapper for API requests with retries, error handling, and backoff."""
        retries = 5
        backoff = 1.0
        for attempt in range(retries):
            try:
                r = await self.client.request(method, url, **kwargs)
                if r.status_code in (429, 502, 503, 504):  # retryable errors
                    retry_after = r.headers.get("Retry-After")
                    if retry_after:
                        await asyncio.sleep(float(retry_after))
                    else:
                        await asyncio.sleep(backoff)
                        backoff = min(backoff * 2, 20) + random.random()
                    continue

                if r.status_code >= 400:
                    return {"error": f"GitHub API error {r.status_code}: {r.text}"}

                return r.json()

            except httpx.RequestError as e:
                if attempt == retries - 1:
                    return {"error": f"Network error: {e}"}
                await asyncio.sleep(backoff)
                backoff = min(backoff * 2, 20) + random.random()

        return {"error": "Max retries exceeded"}

    async def create_issue(
        self,
        title: str,
        body: str,
        owner: str,
        repo_name: str,
    ) -> tuple[Optional[int],
               Optional[str]]:
        """Create a new issue in a repository."""
        data = {"title": title, "body": body}
        r = await self._request("POST", f"/repos/{owner}/{repo_name}/issues", json=data)
        if "error" in r:
            return None, r["error"]
        return r["number"], None

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
    ) -> tuple[Optional[int],
               Optional[str]]:
        """Create a PR with file changes (create/update branch + file + PR)."""

        # Get base branch SHA
        base_ref = await self._request(
            "GET",
            f"/repos/{owner}/{repo_name}/git/ref/heads/{base_branch}"
        )
        if "error" in base_ref:
            return None, base_ref["error"]
        base_sha = base_ref["object"]["sha"]

        # Create or update head branch
        head_ref = await self._request(
            "POST",
            f"/repos/{owner}/{repo_name}/git/refs",
            json={
                "ref": f"refs/heads/{head_branch}",
                "sha": base_sha
            }
        )
        if "error" in head_ref and "Reference already exists" in head_ref["error"]:
            # Update branch to latest base
            await self._request(
                "PATCH",
                f"/repos/{owner}/{repo_name}/git/refs/heads/{head_branch}",
                json={
                    "sha": base_sha,
                    "force": True
                }
            )

        # Try updating file, else create new one
        existing_file = await self._request(
            "GET",
            f"/repos/{owner}/{repo_name}/contents/{file_path_to_change}",
            params={"ref": head_branch}
        )
        if "error" not in existing_file and "sha" in existing_file:
            await self._request(
                "PUT",
                f"/repos/{owner}/{repo_name}/contents/{file_path_to_change}",
                json={
                    "message": commit_message,
                    "content": base64.b64encode(file_content_to_change.encode()).decode(),
                    "sha": existing_file["sha"],
                    "branch": head_branch
                }
            )
        else:
            await self._request(
                "PUT",
                f"/repos/{owner}/{repo_name}/contents/{file_path_to_change}",
                json={
                    "message": commit_message,
                    "content": base64.b64encode(file_content_to_change.encode()).decode(),
                    "branch": head_branch
                }
            )

        # Create PR
        pr = await self._request(
            "POST",
            f"/repos/{owner}/{repo_name}/pulls",
            json={
                "title": title,
                "body": body,
                "base": base_branch,
                "head": head_branch
            }
        )
        if "error" in pr:
            return None, pr["error"]

        return pr["number"], None

    async def get_file_content(
        self,
        owner: str,
        repo_name: str,
        file_path: str,
        ref: str = "main",
    ) -> tuple[Optional[list[str]],
               Optional[str]]:
        """Get file content from a repository branch/commit."""
        r = await self._request(
            "GET",
            f"/repos/{owner}/{repo_name}/contents/{file_path}",
            params={"ref": ref}
        )
        if "error" in r:
            return None, r["error"]

        try:
            content = base64.b64decode(r["content"]).decode("utf-8")
            return content.splitlines(), None
        except Exception as e:
            return None, f"Failed to decode file content: {e}"

    async def get_line_context_content(
        self,
        lines: list[str],
        line_number: int,
        line_context_len: int = 5,
    ) -> Optional[tuple[list[str],
                        str,
                        list[str]]]:
        """Get specific line with surrounding context."""
        if not lines or not (1 <= line_number <= len(lines)):
            return None

        start_line = max(1, line_number - line_context_len)
        end_line = min(len(lines), line_number + line_context_len)

        return (
            lines[start_line - 1:line_number - 1],
            lines[line_number - 1],
            lines[line_number:end_line]
        )

    async def close(self):
        """Gracefully close the HTTPX client session."""
        await self.client.aclose()
