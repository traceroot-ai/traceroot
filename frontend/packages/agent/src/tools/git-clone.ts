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

const GITHUB_REPO_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?\/[A-Za-z0-9._-]+$/;
const GIT_REF_PATTERN = /^[A-Za-z0-9._/-]+$/;
const FULL_OR_SHORT_SHA_PATTERN = /^[0-9a-f]{7,40}$/i;

function validationError(text: string): AgentToolResult<undefined> {
  return { content: [{ type: "text", text }], details: undefined };
}

function validateCloneParams(repo: string, ref?: string): string | null {
  if (!GITHUB_REPO_PATTERN.test(repo)) {
    return "Invalid repository. Use GitHub 'owner/repo' format.";
  }

  if (
    ref !== undefined &&
    (!GIT_REF_PATTERN.test(ref) ||
      ref.includes("..") ||
      ref.startsWith("/") ||
      ref.endsWith("/") ||
      ref.includes("//"))
  ) {
    return "Invalid git ref. Use a branch, tag, or commit SHA containing only letters, numbers, '.', '_', '-', and '/'.";
  }

  return null;
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
      const invalid = validateCloneParams(params.repo, params.ref);
      if (invalid) return validationError(invalid);

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
        const cloneUrl = `https://github.com/${params.repo}.git`;
        const askpassPath = "/tmp/git-askpass.sh";
        await executor.writeFile(
          askpassPath,
          [
            "#!/bin/sh",
            'case "$1" in',
            '  Username*) printf "%s" "$GIT_USERNAME" ;;',
            '  Password*) printf "%s" "$GIT_PASSWORD" ;;',
            "esac",
            "",
          ].join("\n"),
        );
        await executor.exec(`chmod +x ${askpassPath}`);

        let cloneCmd: string;
        if (!params.ref) {
          cloneCmd = `git -c credential.helper= -c core.hooksPath=/dev/null clone --depth 1 -- "$GIT_URL" "$GIT_DEST"`;
        } else if (FULL_OR_SHORT_SHA_PATTERN.test(params.ref)) {
          cloneCmd = `git -c credential.helper= -c core.hooksPath=/dev/null clone -- "$GIT_URL" "$GIT_DEST" && git -c credential.helper= -c core.hooksPath=/dev/null -C "$GIT_DEST" checkout "$GIT_REF"`;
        } else {
          cloneCmd = `git -c credential.helper= -c core.hooksPath=/dev/null clone --depth 1 --branch "$GIT_REF" -- "$GIT_URL" "$GIT_DEST"`;
        }

        const result = await executor.exec(`( ${cloneCmd} ) 2>&1`, {
          timeout: 120,
          env: {
            GIT_ASKPASS: askpassPath,
            GIT_TERMINAL_PROMPT: "0",
            GIT_USERNAME: "x-access-token",
            GIT_PASSWORD: token,
            GIT_URL: cloneUrl,
            GIT_DEST: clonePath,
            ...(params.ref ? { GIT_REF: params.ref } : {}),
          },
        });

        if (result.code !== 0) {
          // Sanitize error (remove token from output)
          const output = result.stderr || result.stdout || "";
          const sanitizedErr = output.replaceAll(token, "[REDACTED]");
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
