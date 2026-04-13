import { Type } from "@mariozechner/pi-ai";
import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";

const schema = Type.Object({
  repo: Type.String({ description: "Repository in 'owner/repo' format" }),
});

export function createCheckGitHubAccessTool(
  userId: string,
  uiBaseUrl: string,
): AgentTool<typeof schema> {
  return {
    name: "check_github_access",
    label: "Check GitHub access",
    description:
      "Check if your GitHub App installation has access to a repository. Use this before attempting to clone.",
    parameters: schema,
    execute: async (_, params): Promise<AgentToolResult<undefined>> => {
      // 1. Get installation token from UI service (pass repo to resolve correct installation)
      const tokenRes = await fetch(
        `${uiBaseUrl}/api/github/token?repo=${encodeURIComponent(params.repo)}`,
        {
          headers: {
            "x-user-id": userId,
            "X-Internal-Secret": process.env.INTERNAL_API_SECRET || "",
          },
        },
      );

      if (!tokenRes.ok) {
        return {
          content: [
            {
              type: "text",
              text: `No GitHub App installed.\n\nPlease ask the user to install the GitHub App at /settings/github`,
            },
          ],
          details: undefined,
        };
      }

      const { token } = await tokenRes.json();

      // 2. Check if installation has access to this repo
      const repoRes = await fetch(`https://api.github.com/repos/${params.repo}`, {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github.v3+json",
          "User-Agent": "TraceRoot-Agent",
        },
      });

      if (repoRes.ok) {
        const repoData = await repoRes.json();
        return {
          content: [
            {
              type: "text",
              text: `Access confirmed to ${params.repo}\n\nDefault branch: ${repoData.default_branch}\nYou can now use git_clone to clone this repository.`,
            },
          ],
          details: undefined,
        };
      } else if (repoRes.status === 404) {
        return {
          content: [
            {
              type: "text",
              text: `No access to ${params.repo}\n\nThe repository either doesn't exist or isn't included in the user's GitHub App installation.\n\nAsk the user to add this repository to their GitHub App at /settings/github`,
            },
          ],
          details: undefined,
        };
      } else {
        return {
          content: [
            {
              type: "text",
              text: `GitHub API error: ${repoRes.status}\n\n${await repoRes.text()}`,
            },
          ],
          details: undefined,
        };
      }
    },
  };
}
