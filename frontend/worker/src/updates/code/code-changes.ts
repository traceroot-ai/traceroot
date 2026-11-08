import { repoAllowed, type WindowAggregates } from "@traceroot/core/updates";
import { fetchRepoMetadata, type GithubApiConfig } from "./github-api.js";
import { joinChangesToTraffic, type CodeChangeItem, type JoinMethod } from "./join.js";
import {
  DEFAULT_REPO_LIMITS,
  readRepo,
  type RepoReadFailure,
  type RepoReadLimits,
  type RepoReader,
} from "./repo-reader.js";
import type { SandboxProvider } from "./sandbox.js";

/**
 * Everything the update knows about code changes for one run: whether the
 * section applies, what the host says merged, what the clone adds, and, when the
 * clone could not be used, plainly why. Gathering never throws into the run: a
 * failure becomes a note the reader sees.
 */

export interface CodeChangesDeps {
  /** Null where no sandbox is available: the section then runs on the host's metadata alone. */
  provider: SandboxProvider | null;
  github: { baseUrl: string; fetchImpl?: GithubApiConfig["fetchImpl"] };
  /** A per-run installation token for a repository, minted for this run only. */
  tokenFor: (repo: string, workspaceId: string) => Promise<string>;
  limits?: RepoReadLimits;
  /**
   * Check, by trying, that the analysis sandbox has no network and holds no token before the
   * agent reads anything from it; a sandbox that fails the check is not used. On by default;
   * only a stand-in that isolates nothing turns it off.
   */
  verifyIsolation?: boolean;
  /** One line per sandbox event, for the worker's log. */
  log?: (line: string) => void;
  /** Where things live inside a sandbox; for tests that stand in for one. */
  layout?: { work: string; tmp: string };
  /** Where a clone is fetched from; the host's clone_url unless a deployment overrides it. */
  cloneUrlFor?: (repo: string, hostCloneUrl: string | null) => string;
}

export interface CodeChangesWindow {
  windowStart: Date;
  windowEnd: Date;
  prevWindowStart: Date;
}

export type CodeChangesStatus =
  | "off"
  | "no_git_context"
  | "not_allowed"
  | "no_repository_data"
  | "ready";

export interface CodeChangesReport {
  status: CodeChangesStatus;
  repo: string | null;
  hasGitContext: boolean;
  method: JoinMethod;
  methodNote: string;
  clone: {
    mode: "clone" | "api_only";
    fallbackReason?: RepoReadFailure | "not_attempted";
    note: string;
  };
  items: CodeChangeItem[];
  /** Recent commits seen in the clone (their messages are customer text). */
  commits: { sha: string; at: string; subject: string; fileCount: number }[];
  /** The opening lines of a few of the files the changes touched, from the read-only copy: for reading, not quoting. */
  excerpts: { path: string; lines: string }[];
  notes: string[];
}

export interface CodeChangesGather {
  report: CodeChangesReport;
  /** Open while the agent may read files; call close() when the run is done, whatever happened. */
  reader: RepoReader | null;
  /** Links the update may cite from this section. */
  allowedUrls: string[];
  close(): Promise<void>;
}

const MAX_EXCERPT_FILES = 4;
const EXCERPT_LINES = 15;

const FALLBACK_TEXT: Record<RepoReadFailure | "not_attempted", string> = {
  timeout: "the clone timed out",
  oversize: "the repository is larger than the size limit",
  unreachable: "the repository could not be reached",
  failed: "the clone failed",
  not_attempted: "no sandbox was available",
};

function fallbackNote(reason: RepoReadFailure | "not_attempted"): string {
  return `Code diffs unavailable this period: ${FALLBACK_TEXT[reason]}; showing pull request and release metadata only.`;
}

function emptyReport(
  status: CodeChangesStatus,
  notes: string[],
  hasGitContext: boolean,
): CodeChangesReport {
  return {
    status,
    repo: null,
    hasGitContext,
    method: "none",
    methodNote: "",
    clone: { mode: "api_only", fallbackReason: "not_attempted", note: "" },
    items: [],
    commits: [],
    excerpts: [],
    notes,
  };
}

const nothingOpen = (report: CodeChangesReport): CodeChangesGather => ({
  report,
  reader: null,
  allowedUrls: [],
  close: async () => undefined,
});

export async function gatherCodeChanges(
  deps: CodeChangesDeps,
  settings: { enabled: boolean; repos: string[]; workspaceId: string },
  aggregates: { current: WindowAggregates; previous: WindowAggregates },
  window: CodeChangesWindow,
): Promise<CodeChangesGather> {
  const { current, previous } = aggregates;
  const hasGitContext = current.totals.gitContextTraces > 0;

  if (!settings.enabled) return nothingOpen(emptyReport("off", [], hasGitContext));

  if (!hasGitContext || current.repos.length === 0) {
    return nothingOpen(
      emptyReport(
        "no_git_context",
        [
          "The traces in this window carry no git context (no repository or commit), so there is nothing to join code changes to.",
        ],
        false,
      ),
    );
  }

  const named = current.repos.map((r) => r.name);
  const allowed = named.filter((repo) => repoAllowed(settings.repos, repo));
  if (allowed.length === 0) {
    return nothingOpen(
      emptyReport(
        "not_allowed",
        [
          `The repositories named by the traces (${named.join(", ")}) are not on this project's list, so no code was read.`,
        ],
        true,
      ),
    );
  }

  // The repository carrying the most traffic; one is enough for an update.
  const repo = allowed[0];
  const notes: string[] = [];
  if (allowed.length > 1)
    notes.push(`Only ${repo} was read; ${allowed.slice(1).join(", ")} also appear in the traces.`);
  const limits = deps.limits ?? DEFAULT_REPO_LIMITS;

  let token: string;
  try {
    token = await deps.tokenFor(repo, settings.workspaceId);
  } catch {
    return nothingOpen(
      emptyReport(
        "no_repository_data",
        [...notes, `No access token could be obtained for ${repo}; code changes were skipped.`],
        true,
      ),
    );
  }

  const api: GithubApiConfig = {
    baseUrl: deps.github.baseUrl,
    token,
    fetchImpl: deps.github.fetchImpl,
  };
  let metadata;
  try {
    metadata = await fetchRepoMetadata(api, repo, window.windowStart, window.windowEnd);
  } catch {
    return nothingOpen(
      emptyReport(
        "no_repository_data",
        [...notes, `The code host did not answer for ${repo}; code changes were skipped.`],
        true,
      ),
    );
  }

  let reader: RepoReader | null = null;
  let commits: Awaited<ReturnType<RepoReader["commitsSince"]>> | null = null;
  let clone: CodeChangesReport["clone"];

  // The host's size counts the whole history; the clone is blobless and shallow, so the limit is
  // enforced on the clone itself. This only refuses repositories no clone could be expected to fit.
  const tooBig =
    metadata.repo.sizeKb !== null && metadata.repo.sizeKb * 1024 > limits.maxRepoBytes * 40;
  if (!deps.provider) {
    clone = {
      mode: "api_only",
      fallbackReason: "not_attempted",
      note: fallbackNote("not_attempted"),
    };
  } else if (tooBig) {
    clone = { mode: "api_only", fallbackReason: "oversize", note: fallbackNote("oversize") };
  } else {
    const hostCloneUrl = metadata.repo.cloneUrl;
    const cloneUrl =
      deps.cloneUrlFor?.(repo, hostCloneUrl) ?? hostCloneUrl ?? `https://github.com/${repo}.git`;
    const outcome = await readRepo({
      provider: deps.provider,
      cloneUrl,
      token,
      sinceIso: window.prevWindowStart.toISOString(),
      changedPaths: metadata.pulls.flatMap((p) => p.files),
      limits,
      layout: deps.layout,
    });
    if (outcome.ok) {
      const candidate = outcome.reader;
      let usable = true;
      if (deps.verifyIsolation !== false) {
        const iso = await candidate.verifyIsolation().catch(() => null);
        usable = iso !== null && iso.egressBlocked && !iso.tokenInEnvironment && !iso.tokenOnDisk;
        deps.log?.(
          `sandbox provider=${deps.provider.name} repo=${repo} isolation=${JSON.stringify(iso)} accepted=${usable}`,
        );
      }
      if (usable) {
        try {
          commits = await candidate.commitsSince(window.prevWindowStart.toISOString());
        } catch {
          usable = false;
        }
      }
      if (usable) {
        reader = candidate;
        clone = {
          mode: "clone",
          note: `Read from a ${outcome.method}, limited to history since the previous window.`,
        };
      } else {
        await candidate.close();
        clone = { mode: "api_only", fallbackReason: "failed", note: fallbackNote("failed") };
      }
    } else {
      clone = {
        mode: "api_only",
        fallbackReason: outcome.reason,
        note: fallbackNote(outcome.reason),
      };
    }
  }

  const joined = joinChangesToTraffic({
    pulls: metadata.pulls,
    releases: metadata.releases,
    current,
    previous,
    commits,
  });
  const excerpts: CodeChangesReport["excerpts"] = [];
  if (reader) {
    // The files behind a shift first, then the rest, a few lines each.
    const ordered = [
      ...joined.items.filter((i) => i.evidence !== null),
      ...joined.items.filter((i) => i.evidence === null),
    ].flatMap((i) => i.files);
    for (const file of [...new Set(ordered)].slice(0, MAX_EXCERPT_FILES)) {
      try {
        excerpts.push({ path: file, lines: await reader.readFile(file, EXCERPT_LINES) });
      } catch {
        // A file the copy does not hold is simply not shown.
      }
    }
  }
  const report: CodeChangesReport = {
    status: "ready",
    repo,
    hasGitContext: joined.hasGitContext,
    method: joined.method,
    methodNote: joined.methodNote,
    clone,
    items: joined.items,
    commits: (commits ?? [])
      .slice(0, 30)
      .map((c) => ({ sha: c.sha, at: c.at, subject: c.subject, fileCount: c.files.length })),
    excerpts,
    notes,
  };
  return {
    report,
    reader,
    allowedUrls: joined.items.map((i) => i.url),
    close: async () => {
      await reader?.close();
    },
  };
}
