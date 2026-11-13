import { Type } from "@earendil-works/pi-ai";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import type { Executor } from "../executors/interface.js";
import { agentInternalSecret } from "../internal-secret.js";

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
 * Characters git forbids in a ref name (`git check-ref-format`): ASCII control
 * characters, space, and ~ ^ : ? * [ \\. Everything else — including + = @ ,
 * which appear in real branch names — is allowed. This is a denylist rather
 * than an allowlist because the value never reaches a shell: it travels to git
 * through the environment (see executors/git-clone-command.ts), so the job here
 * is to reject refs git itself would reject, not to guess at shell safety.
 */
// eslint-disable-next-line no-control-regex
const REF_FORBIDDEN_RE = /[\x00-\x20\x7f~^:?*[\\]/;

export function isValidRepo(repo: string): boolean {
  return REPO_RE.test(repo);
}

export function isValidRef(ref: string): boolean {
  if (ref.length === 0 || REF_FORBIDDEN_RE.test(ref)) return false;
  // A leading dash would be parsed by git as an option rather than a ref.
  if (ref.startsWith("-")) return false;
  if (ref.includes("..") || ref.includes("@{")) return false;
  if (ref === "@" || ref.endsWith(".") || ref.endsWith("/")) return false;

  // Each slash-separated component must be non-empty, must not start with a
  // dot, and must not end with .lock — this is what rejects "/main", "a//b",
  // "a/.b" and "a/b.lock".
  return ref
    .split("/")
    .every((part) => part.length > 0 && !part.startsWith(".") && !part.endsWith(".lock"));
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
      "Clone a GitHub repository into the sandbox. Uses the user's GitHub App installation for authentication. After cloning, use bash/read to explore the code and the github_* tools for commit and pull request history.",
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
            "X-Internal-Secret": agentInternalSecret(),
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
        await executor.cloneRepo(`https://github.com/${params.repo}.git`, clonePath, {
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

      // 6. Commit identity for any local commits. No credential is stored in
      // the sandbox: GitHub reads go through the host-side github_* tools.
      const name = github_username || "TraceRoot Agent";
      const email = github_username
        ? `${github_username}@users.noreply.github.com`
        : "agent@traceroot.ai";
      await executor.exec(
        `git config --global user.name "$GIT_NAME" && git config --global user.email "$GIT_EMAIL"`,
        { env: { GIT_NAME: name, GIT_EMAIL: email } },
      );

      return {
        content: [
          {
            type: "text",
            text: `Cloned ${params.repo} to ${clonePath}\n\nCommit: ${commitInfo.stdout.trim()}\n${params.ref ? `Ref: ${params.ref}` : "(default branch)"}\n\nYou can now explore the code:\n  bash: ls ${clonePath}\n  bash: cat ${clonePath}/README.md\n  bash: git -C ${clonePath} log --oneline -10\n  github_pulls: repo ${params.repo}, state merged`,
          },
        ],
        details: undefined,
      };
    },
  };
}
