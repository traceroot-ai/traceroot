import { Type } from "@earendil-works/pi-ai";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
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

/**
 * GitHub owner/repo: both segments allow only letters, digits, `.`, `_`, `-`.
 */
const REPO_RE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

/**
 * Conservative subset of git's ref rules (`git check-ref-format`). We reject
 * rather than escape: refs have no legitimate need for shell metacharacters, so
 * anything outside this set is a user error, not something to sanitize.
 */
const REF_RE = /^[A-Za-z0-9._/-]+$/;

export function isValidRepo(repo: string): boolean {
  return REPO_RE.test(repo);
}

export function isValidRef(ref: string): boolean {
  return (
    REF_RE.test(ref) &&
    // A leading dash would be parsed by git as an option, not a ref.
    !ref.startsWith("-") &&
    !ref.includes("..") &&
    !ref.endsWith("/") &&
    !ref.endsWith(".lock")
  );
}

export function createGitCloneTool(
  workspaceId: string,
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
      // Validate before touching the network or the sandbox. These values reach
      // a path on disk and (via cloneRepo) the git CLI, so reject anything
      // outside the expected character sets rather than trying to escape it.
      if (!isValidRepo(params.repo)) {
        return {
          content: [
            {
              type: "text",
              text: `Invalid repository "${params.repo}". Expected 'owner/repo' using letters, digits, '.', '_' or '-'.`,
            },
          ],
          details: undefined,
        };
      }
      if (params.ref !== undefined && !isValidRef(params.ref)) {
        return {
          content: [
            {
              type: "text",
              text: `Invalid ref "${params.ref}". Expected a branch, tag, or commit SHA using letters, digits, '.', '_', '/' or '-'.`,
            },
          ],
          details: undefined,
        };
      }

      // Ensure sandbox is ready
      if (!executor.isReady()) {
        await executor.init();
      }

      // 1. Get installation token (pass repo to resolve correct installation for org repos)
      const tokenRes = await fetch(
        `${uiBaseUrl}/api/github/token?repo=${encodeURIComponent(params.repo)}`,
        {
          headers: {
            "x-workspace-id": workspaceId,
            "X-Internal-Secret": process.env.INTERNAL_API_SECRET || "",
          },
        },
      );

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

      // 4. Clone. Both executors implement cloneRepo() with the same
      // injection-safe construction (see executors/git-clone-command.ts): the
      // URL, ref, destination and token travel via the environment, never
      // interpolated into a shell command.
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
