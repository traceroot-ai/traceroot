import { Type } from "@mariozechner/pi-ai";
import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import type { Executor } from "../executors/interface.js";
import { setupGhCli } from "../executors/docker.js";
import { setupGhCliDaytona } from "../executors/daytona.js";

const schema = Type.Object({
  label: Type.String({ description: "Brief description of what you're cloning" }),
  repo: Type.String({ description: "Repository in 'owner/repo' format" }),
  ref: Type.Optional(
    Type.String({ description: "Branch, tag, or commit SHA (default: default branch)" }),
  ),
});

export function createGitCloneTool(
  userId: string,
  uiBaseUrl: string,
  executor: Executor,
): AgentTool<typeof schema> {
  return {
    name: "git_clone",
    label: "Clone repository",
    description:
      "Clone a GitHub repository into the sandbox. Uses the user's GitHub App installation for authentication. After cloning, use bash/read to explore the code.",
    parameters: schema,
    execute: async (_, params): Promise<AgentToolResult<undefined>> => {
      // Ensure sandbox is ready
      if (!executor.isReady()) {
        await executor.init();
      }

      // 1. Get installation token
      const tokenRes = await fetch(`${uiBaseUrl}/api/github/token`, {
        headers: {
          "x-user-id": userId,
          "X-Internal-Secret": process.env.INTERNAL_API_SECRET || "",
        },
      });

      if (!tokenRes.ok) {
        return {
          content: [
            {
              type: "text",
              text: "No GitHub App installed. Cannot clone private repositories.",
            },
          ],
          details: undefined,
        };
      }

      const { token, github_username } = await tokenRes.json();

      // 2. Prepare clone
      const workDir = executor.getWorkspacePath();
      const repoPath = params.repo.replaceAll("/", "_");
      const clonePath = `${workDir}/repos/${repoPath}`;

      // 3. Ensure repos dir exists
      await executor.exec(`mkdir -p ${workDir}/repos`);

      // 4. Clone — native SDK path (Daytona) or exec fallback (Docker)
      if (executor.hasNativeGit?.()) {
        try {
          await executor.cloneRepo!(`https://github.com/${params.repo}.git`, clonePath, {
            ref: params.ref,
            username: "x-access-token",
            password: token,
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return {
            content: [
              {
                type: "text",
                text: `Clone failed:\n${msg.replaceAll(token, "[REDACTED]")}`,
              },
            ],
            details: undefined,
          };
        }
      } else {
        const cloneUrl = `https://x-access-token:${token}@github.com/${params.repo}.git`;

        let cloneCmd: string;
        if (params.ref) {
          // Try as branch/tag first, fall back to fetch+checkout for commit SHAs
          cloneCmd = `git clone --depth 1 --branch "${params.ref}" "${cloneUrl}" "${clonePath}" 2>/dev/null || (git clone "${cloneUrl}" "${clonePath}" && cd "${clonePath}" && git checkout "${params.ref}")`;
        } else {
          cloneCmd = `git clone --depth 1 "${cloneUrl}" "${clonePath}"`;
        }

        const result = await executor.exec(cloneCmd, { timeout: 120 });

        if (result.code !== 0) {
          // Sanitize error (remove token from output)
          const sanitizedErr = result.stderr.replace(token, "[REDACTED]");
          return {
            content: [
              {
                type: "text",
                text: `Clone failed:\n${sanitizedErr}`,
              },
            ],
            details: undefined,
          };
        }
      }

      // 5. Get commit info
      const commitInfo = await executor.exec(`cd "${clonePath}" && git log -1 --format="%h %s"`);

      // 6. Set up gh CLI in sandbox (install + authenticate) so agent can query PRs/issues
      try {
        if (executor.hasNativeGit?.()) {
          await setupGhCliDaytona(executor, token, github_username);
        } else {
          await setupGhCli(executor, token, github_username);
        }
      } catch {
        // Non-fatal — clone succeeded, gh is a nice-to-have
        console.warn("[git_clone] Failed to set up gh CLI in sandbox");
      }

      return {
        content: [
          {
            type: "text",
            text: `Cloned ${params.repo} to ${clonePath}\n\nCommit: ${commitInfo.stdout.trim()}\n${params.ref ? `Ref: ${params.ref}` : "(default branch)"}\n\nYou can now explore the code:\n  bash: ls ${clonePath}\n  bash: cat ${clonePath}/README.md\n  bash: git -C ${clonePath} log --oneline -10\n  bash: gh pr list --repo ${params.repo} --state merged --limit 5`,
          },
        ],
        details: undefined,
      };
    },
  };
}
