import { DEFAULT_NOISE_RULES, zScore, type WindowAggregates } from "@traceroot/core/updates";
import type { RepoCommit } from "./repo-reader.js";
import type { RepoPull, RepoRelease } from "./types.js";

/**
 * Setting what merged beside how traffic moved, in code.
 *
 * The comparison is never causal. A change is joined to traffic by the commit
 * the traces carry (the trace's git ref), failing that by the source files the
 * spans point at, failing that by time alone, and the report says which. The
 * numbers are worked out here under the same noise rules as the rest of the
 * update, and every sentence of evidence is written here, so the model only
 * has to say it.
 */

export type JoinMethod = "ref_split" | "changed_files" | "time_only" | "none";

export interface RefTraffic {
  ref: string;
  traces: number;
  failedTraces: number;
  errorRate: number;
  baselineErrorRate: number;
  baselineTraces: number;
  /** "higher": a rise past the noise rules. "not_higher": enough traffic and no rise. */
  verdict: "higher" | "not_higher" | "too_few_traces";
}

export interface FileTraffic {
  file: string;
  spans: number;
  failedSpans: number;
  errorRate: number;
  baselineErrorRate: number;
  baselineSpans: number;
  verdict: "higher" | "not_higher" | "too_few_spans";
}

export interface CodeChangeItem {
  kind: "pull_request" | "release";
  /** "PR #101" or "release v1.4.0". */
  label: string;
  /** The title as the host has it: customer text, shown as data. */
  title: string;
  at: string;
  url: string;
  sha: string;
  /** Paths changed (pull requests, from the host) or touched by the commit (releases, from the clone). */
  files: string[];
  traffic: RefTraffic | null;
  fileTraffic: FileTraffic[];
  /** One sentence of fact for the reader, or null when the traffic shows nothing worth saying. */
  evidence: string | null;
}

export interface JoinInput {
  pulls: RepoPull[];
  releases: RepoRelease[];
  current: WindowAggregates;
  previous: WindowAggregates;
  /** Commits read from the clone, when it worked; used to name the files a release touched. */
  commits: RepoCommit[] | null;
}

export interface JoinResult {
  method: JoinMethod;
  methodNote: string;
  hasGitContext: boolean;
  items: CodeChangeItem[];
}

const rules = DEFAULT_NOISE_RULES.errorRate;

function verdictFor(
  base: { failures: number; total: number },
  now: { failures: number; total: number },
  minSample: number,
): "higher" | "not_higher" | "too_few" {
  if (base.total < minSample || now.total < minSample) return "too_few";
  const baseRate = base.failures / base.total;
  const rate = now.failures / now.total;
  const rises =
    rate - baseRate >= rules.minAbs &&
    (baseRate === 0 || (rate - baseRate) / baseRate >= rules.minRel) &&
    now.failures - baseRate * now.total >= rules.minFailures &&
    zScore(base, now) >= rules.minZ;
  return rises ? "higher" : "not_higher";
}

const pct = (x: number) => `${(x * 100).toFixed(x >= 0.1 ? 0 : 1)}%`;
const short = (sha: string) => sha.slice(0, 7);

export function joinChangesToTraffic(input: JoinInput): JoinResult {
  const { current, previous } = input;
  const hasGitContext = current.totals.gitContextTraces > 0;
  const baseline = { failures: previous.totals.errorTraces, total: previous.totals.traces };

  const refOf = (sha: string) =>
    current.refs.find((r) => r.name === sha || r.name.startsWith(sha) || sha.startsWith(r.name));
  const fileOf = (path: string, list: WindowAggregates["sourceFiles"]) =>
    list.find((f) => f.file === path);

  const raw: Omit<CodeChangeItem, "traffic" | "fileTraffic" | "evidence">[] = [
    ...input.pulls.map((p) => ({
      kind: "pull_request" as const,
      label: `PR #${p.number}`,
      title: p.title,
      at: p.mergedAt.toISOString(),
      url: p.url,
      sha: p.mergeCommitSha,
      files: p.files,
    })),
    ...input.releases.map((r) => ({
      kind: "release" as const,
      label: `release ${r.tag}`,
      title: r.name,
      at: r.publishedAt.toISOString(),
      url: r.url,
      sha: r.commitSha,
      files: input.commits?.find((c) => c.sha === r.commitSha)?.files.map((f) => f.path) ?? [],
    })),
  ].sort((a, b) => a.at.localeCompare(b.at));

  const anyRefMatched = raw.some((item) => refOf(item.sha));
  const items: CodeChangeItem[] = raw.map((item) => {
    let traffic: RefTraffic | null = null;
    const ref = refOf(item.sha);
    if (ref) {
      const v = verdictFor(
        baseline,
        { failures: ref.errorTraces, total: ref.traces },
        DEFAULT_NOISE_RULES.minSample,
      );
      traffic = {
        ref: ref.name,
        traces: ref.traces,
        failedTraces: ref.errorTraces,
        errorRate: ref.traces === 0 ? 0 : ref.errorTraces / ref.traces,
        baselineErrorRate: baseline.total === 0 ? 0 : baseline.failures / baseline.total,
        baselineTraces: baseline.total,
        verdict: v === "too_few" ? "too_few_traces" : v,
      };
    }

    const fileTraffic: FileTraffic[] = [];
    if (!anyRefMatched) {
      for (const file of item.files) {
        const now = fileOf(file, current.sourceFiles);
        const before = fileOf(file, previous.sourceFiles);
        if (!now || !before) continue;
        const v = verdictFor(
          { failures: before.errors, total: before.spans },
          { failures: now.errors, total: now.spans },
          DEFAULT_NOISE_RULES.minSample,
        );
        fileTraffic.push({
          file,
          spans: now.spans,
          failedSpans: now.errors,
          errorRate: now.errors / now.spans,
          baselineErrorRate: before.errors / before.spans,
          baselineSpans: before.spans,
          verdict: v === "too_few" ? "too_few_spans" : v,
        });
      }
    }

    let evidence: string | null = null;
    if (traffic && traffic.verdict === "higher") {
      evidence =
        `Traces carrying commit ${short(traffic.ref)} (${item.label}, ${item.at.slice(0, 16).replace("T", " ")} UTC): ` +
        `${traffic.failedTraces} of ${traffic.traces} failed (${pct(traffic.errorRate)}), against ${pct(traffic.baselineErrorRate)} ` +
        `for all traffic in the window before.`;
    } else if (!traffic) {
      const rise = fileTraffic.find((f) => f.verdict === "higher");
      if (rise) {
        evidence =
          `Spans pointing at ${rise.file}, which ${item.label} changed: ${rise.failedSpans} of ${rise.spans} failed ` +
          `(${pct(rise.errorRate)}), against ${pct(rise.baselineErrorRate)} in the window before.`;
      }
    }
    return { ...item, traffic, fileTraffic, evidence };
  });

  let method: JoinMethod;
  let methodNote: string;
  if (!hasGitContext) {
    method = "none";
    methodNote =
      "The traces in this window carry no git context (no repository or commit), so changes are listed beside the shifts by time only, with no per-commit comparison.";
  } else if (anyRefMatched) {
    method = "ref_split";
    methodNote =
      "Traffic was split by the commit each trace carries and compared with the previous window's overall error rate.";
  } else if (items.some((i) => i.fileTraffic.length > 0)) {
    method = "changed_files";
    methodNote =
      "No trace carries a commit that matches a merged change, so spans were matched by the source files the changes touched.";
  } else {
    method = "time_only";
    methodNote =
      "The traces carry git context, but none matches a merged change or a changed file, so changes are listed by time only.";
  }
  return { method, methodNote, hasGitContext, items };
}
