import type { RepoInfo, RepoMetadata, RepoPull, RepoRelease } from "./types.js";

/**
 * The read-only slice of the GitHub REST API the code changes section uses:
 * merged pull requests with their changed paths, releases with the commit they
 * point at, and the repository's own record. Every call is a GET. The token
 * is a per-run installation token and travels only in the Authorization header.
 */

export type FetchFn = (
  url: string,
  init: { headers: Record<string, string>; signal?: AbortSignal },
) => Promise<Response>;

export interface GithubApiConfig {
  baseUrl: string;
  token: string;
  fetchImpl?: FetchFn;
  timeoutMs?: number;
}

export class GithubApiError extends Error {
  constructor(
    readonly status: number,
    path: string,
  ) {
    super(`GitHub API ${status} for ${path}`);
  }
}

const MAX_PAGES = 5;
const PER_PAGE = 100;
const MAX_PULL_FILE_PAGES = 3;

async function get<T>(config: GithubApiConfig, path: string): Promise<T> {
  const doFetch: FetchFn = config.fetchImpl ?? ((u, init) => fetch(u, init));
  const response = await doFetch(new URL(path, config.baseUrl).toString(), {
    headers: {
      Authorization: `Bearer ${config.token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    signal: AbortSignal.timeout(config.timeoutMs ?? 20_000),
  });
  if (!response.ok) throw new GithubApiError(response.status, path.split("?")[0]);
  return (await response.json()) as T;
}

const repoPath = (repo: string) => `/repos/${repo.split("/").map(encodeURIComponent).join("/")}`;

export async function fetchRepoInfo(config: GithubApiConfig, repo: string): Promise<RepoInfo> {
  const body = await get<{
    full_name: string;
    default_branch: string;
    size?: number;
    clone_url?: string;
  }>(config, repoPath(repo));
  return {
    fullName: body.full_name,
    defaultBranch: body.default_branch,
    cloneUrl: body.clone_url ?? null,
    sizeKb: typeof body.size === "number" ? body.size : null,
  };
}

interface PullDto {
  number: number;
  title: string;
  merged_at: string | null;
  merge_commit_sha: string | null;
  user?: { login?: string } | null;
  html_url: string;
}

/** Pull requests merged in [from, to), newest first, with the paths each changed. */
export async function fetchMergedPulls(
  config: GithubApiConfig,
  repo: string,
  from: Date,
  to: Date,
): Promise<RepoPull[]> {
  const merged: PullDto[] = [];
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const batch = await get<PullDto[]>(
      config,
      `${repoPath(repo)}/pulls?state=closed&sort=updated&direction=desc&per_page=${PER_PAGE}&page=${page}`,
    );
    merged.push(...batch);
    if (batch.length < PER_PAGE) break;
  }
  const inWindow = merged
    .filter((p) => p.merged_at && p.merge_commit_sha)
    .filter((p) => {
      const at = new Date(p.merged_at as string).getTime();
      return at >= from.getTime() && at < to.getTime();
    })
    .sort((a, b) => (a.merged_at as string).localeCompare(b.merged_at as string));

  const pulls: RepoPull[] = [];
  for (const p of inWindow) {
    const files: string[] = [];
    for (let page = 1; page <= MAX_PULL_FILE_PAGES; page += 1) {
      const batch = await get<{ filename: string }[]>(
        config,
        `${repoPath(repo)}/pulls/${p.number}/files?per_page=${PER_PAGE}&page=${page}`,
      );
      files.push(...batch.map((f) => f.filename));
      if (batch.length < PER_PAGE) break;
    }
    pulls.push({
      number: p.number,
      title: p.title,
      mergedAt: new Date(p.merged_at as string),
      mergeCommitSha: p.merge_commit_sha as string,
      author: p.user?.login ?? "unknown",
      url: p.html_url,
      files,
    });
  }
  return pulls;
}

interface ReleaseDto {
  tag_name: string;
  name: string | null;
  published_at: string | null;
  html_url: string;
}

/** Releases published in [from, to), each resolved to the commit its tag points at. */
export async function fetchReleases(
  config: GithubApiConfig,
  repo: string,
  from: Date,
  to: Date,
): Promise<RepoRelease[]> {
  const batch = await get<ReleaseDto[]>(config, `${repoPath(repo)}/releases?per_page=${PER_PAGE}`);
  const inWindow = batch.filter((r) => {
    if (!r.published_at) return false;
    const at = new Date(r.published_at).getTime();
    return at >= from.getTime() && at < to.getTime();
  });
  const releases: RepoRelease[] = [];
  for (const r of inWindow) {
    const commit = await get<{ sha: string }>(
      config,
      `${repoPath(repo)}/commits/${encodeURIComponent(r.tag_name)}`,
    );
    releases.push({
      tag: r.tag_name,
      name: r.name ?? r.tag_name,
      publishedAt: new Date(r.published_at as string),
      commitSha: commit.sha,
      url: r.html_url,
    });
  }
  return releases.sort((a, b) => a.publishedAt.getTime() - b.publishedAt.getTime());
}

export async function fetchRepoMetadata(
  config: GithubApiConfig,
  repo: string,
  from: Date,
  to: Date,
): Promise<RepoMetadata> {
  const [info, pulls, releases] = await Promise.all([
    fetchRepoInfo(config, repo),
    fetchMergedPulls(config, repo, from, to),
    fetchReleases(config, repo, from, to),
  ]);
  return { repo: info, pulls, releases };
}
