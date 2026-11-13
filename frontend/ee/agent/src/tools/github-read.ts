import { Type } from "@earendil-works/pi-ai";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { agentInternalSecret } from "../internal-secret.js";
import { isValidRepo } from "./git-clone.js";
import { truncateHead } from "./truncate.js";

const GITHUB_API = "https://api.github.com";
const MAX_LIST = 50;
const DEFAULT_LIST = 10;
const MAX_DIFF_BYTES = 50 * 1024;

const repoField = Type.String({ description: "Repository in 'owner/repo' format" });
const limitField = Type.Optional(
  Type.Number({ description: `Number of results (default ${DEFAULT_LIST}, max ${MAX_LIST})` }),
);

type Text = AgentToolResult<undefined>;

function text(message: string): Text {
  return { content: [{ type: "text", text: message }], details: undefined };
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_LIST;
  return Math.min(Math.max(Math.trunc(limit), 1), MAX_LIST);
}

/**
 * Read-only GitHub requests made by the agent host. The installation token is
 * fetched per call and stays in this process; only response text reaches the
 * model.
 */
async function githubGet(
  workspaceId: string,
  uiBaseUrl: string,
  repo: string,
  path: string,
  query: Record<string, string>,
  accept = "application/vnd.github+json",
): Promise<{ ok: true; body: string } | { ok: false; message: string }> {
  let tokenRes: Response;
  try {
    tokenRes = await fetch(`${uiBaseUrl}/api/github/token?repo=${encodeURIComponent(repo)}`, {
      headers: { "x-workspace-id": workspaceId, "X-Internal-Secret": agentInternalSecret() },
    });
  } catch {
    return { ok: false, message: "Could not reach the GitHub token service." };
  }
  if (!tokenRes.ok) {
    return { ok: false, message: "No GitHub App installed for this repository." };
  }
  const { token } = (await tokenRes.json()) as { token: string };

  const url = new URL(`${GITHUB_API}/repos/${repo}${path}`);
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  let res: Response;
  let body: string;
  try {
    res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: accept,
        "User-Agent": "TraceRoot-Agent",
      },
    });
    body = await res.text();
  } catch {
    return { ok: false, message: "Could not reach the GitHub API." };
  }
  if (!res.ok) {
    const detail = body.replaceAll(token, "[REDACTED]").slice(0, 300);
    const hint =
      res.status === 403 || res.status === 404
        ? " The GitHub App may lack read access to this repository or to pull requests."
        : "";
    return { ok: false, message: `GitHub API error ${res.status}.${hint}\n${detail}` };
  }
  return { ok: true, body };
}

function checkRepo(repo: string): Text | null {
  return isValidRepo(repo) && !repo.split("/").some((part) => part === "." || part === "..")
    ? null
    : text(
        `Invalid repository "${repo}". Expected 'owner/repo' using letters, digits, '.', '_' or '-'.`,
      );
}

const oneLine = (s: unknown) =>
  String(s ?? "")
    .split("\n")[0]
    .slice(0, 200);

const commitsSchema = Type.Object({
  repo: repoField,
  path: Type.Optional(Type.String({ description: "Only commits touching this file or directory" })),
  ref: Type.Optional(Type.String({ description: "Branch, tag or SHA to list from" })),
  since: Type.Optional(Type.String({ description: "Only commits after this ISO 8601 date" })),
  until: Type.Optional(Type.String({ description: "Only commits before this ISO 8601 date" })),
  limit: limitField,
});

export function createGitHubCommitsTool(
  workspaceId: string,
  uiBaseUrl: string,
): AgentTool<typeof commitsSchema> {
  return {
    name: "github_commits",
    label: "List commits",
    description:
      "List recent commits of a GitHub repository, optionally for one path or date range. Read-only; uses the workspace's GitHub App installation.",
    parameters: commitsSchema,
    execute: async (_, params): Promise<Text> => {
      const invalid = checkRepo(params.repo);
      if (invalid) return invalid;
      const query: Record<string, string> = { per_page: String(clampLimit(params.limit)) };
      if (params.path) query.path = params.path;
      if (params.ref) query.sha = params.ref;
      if (params.since) query.since = params.since;
      if (params.until) query.until = params.until;
      const r = await githubGet(workspaceId, uiBaseUrl, params.repo, "/commits", query);
      if (!r.ok) return text(r.message);
      const commits = JSON.parse(r.body) as Array<{
        sha: string;
        commit: { message: string; author?: { name?: string; date?: string } };
      }>;
      if (commits.length === 0) return text("No commits found.");
      return text(
        commits
          .map(
            (c) =>
              `${c.sha.slice(0, 7)} ${c.commit.author?.date ?? ""} ${oneLine(c.commit.author?.name)}: ${oneLine(c.commit.message)}`,
          )
          .join("\n"),
      );
    },
  };
}

const pullsSchema = Type.Object({
  repo: repoField,
  state: Type.Optional(
    Type.Union([Type.Literal("open"), Type.Literal("closed"), Type.Literal("all")], {
      description: "Pull request state (default: closed, which includes merged)",
    }),
  ),
  limit: limitField,
});

export function createGitHubPullsTool(
  workspaceId: string,
  uiBaseUrl: string,
): AgentTool<typeof pullsSchema> {
  return {
    name: "github_pulls",
    label: "List pull requests",
    description:
      "List recent pull requests of a GitHub repository, newest first. Read-only; uses the workspace's GitHub App installation.",
    parameters: pullsSchema,
    execute: async (_, params): Promise<Text> => {
      const invalid = checkRepo(params.repo);
      if (invalid) return invalid;
      const r = await githubGet(workspaceId, uiBaseUrl, params.repo, "/pulls", {
        state: params.state ?? "closed",
        sort: "updated",
        direction: "desc",
        per_page: String(clampLimit(params.limit)),
      });
      if (!r.ok) return text(r.message);
      const pulls = JSON.parse(r.body) as Array<{
        number: number;
        title: string;
        state: string;
        merged_at: string | null;
        user?: { login?: string };
      }>;
      if (pulls.length === 0) return text("No pull requests found.");
      return text(
        pulls
          .map(
            (p) =>
              `#${p.number} [${p.merged_at ? `merged ${p.merged_at}` : p.state}] ${oneLine(p.user?.login)}: ${oneLine(p.title)}`,
          )
          .join("\n"),
      );
    },
  };
}

const pullSchema = Type.Object({
  repo: repoField,
  number: Type.Number({ description: "Pull request number" }),
  diff: Type.Optional(Type.Boolean({ description: "Return the diff instead of the description" })),
});

export function createGitHubPullTool(
  workspaceId: string,
  uiBaseUrl: string,
): AgentTool<typeof pullSchema> {
  return {
    name: "github_pull",
    label: "Read pull request",
    description:
      "Read one pull request: its description and state, or with diff=true its diff. Read-only; uses the workspace's GitHub App installation.",
    parameters: pullSchema,
    execute: async (_, params): Promise<Text> => {
      const invalid = checkRepo(params.repo);
      if (invalid) return invalid;
      if (!Number.isInteger(params.number) || params.number < 1) {
        return text("Invalid pull request number.");
      }
      const path = `/pulls/${params.number}`;
      if (params.diff) {
        const r = await githubGet(
          workspaceId,
          uiBaseUrl,
          params.repo,
          path,
          {},
          "application/vnd.github.diff",
        );
        if (!r.ok) return text(r.message);
        return text(truncateHead(r.body, { maxBytes: MAX_DIFF_BYTES }).content || "(empty diff)");
      }
      const r = await githubGet(workspaceId, uiBaseUrl, params.repo, path, {});
      if (!r.ok) return text(r.message);
      const p = JSON.parse(r.body) as {
        number: number;
        title: string;
        state: string;
        merged_at: string | null;
        user?: { login?: string };
        head?: { ref?: string };
        base?: { ref?: string };
        changed_files?: number;
        body?: string | null;
      };
      return text(
        [
          `#${p.number} ${oneLine(p.title)}`,
          `State: ${p.merged_at ? `merged ${p.merged_at}` : p.state}; author: ${oneLine(p.user?.login)}`,
          `Branches: ${oneLine(p.head?.ref)} -> ${oneLine(p.base?.ref)}; files changed: ${p.changed_files ?? "?"}`,
          "",
          truncateHead(p.body ?? "", { maxBytes: 8 * 1024 }).content || "(no description)",
        ].join("\n"),
      );
    },
  };
}
