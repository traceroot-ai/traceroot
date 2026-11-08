import { contentDigest, INJECTION_MARKERS, type Scenario } from "./scenario.js";
import { OVERSIZE_REPO, SEEDED_REPO, UNREACHABLE_REPO_URL } from "./plan.js";

export interface RepoCases {
  /** Bare repositories, as paths relative to the output directory. */
  seeded: { repo: string; path: string };
  oversize: { repo: string; path: string; bytes: number };
  /** The seeded repository served over HTTP with every response held back (`serve-slow`). */
  slow: {
    repo: string;
    path: string;
    url: string;
    delayMs: number;
    approxCloneMs: number;
    port: number;
  };
  unreachable: { repo: string; url: string };
}

/**
 * The record of exactly what was planted. Everything in it derives from the
 * generated rows and the params, with no clock reading, so the same params
 * always give the same manifest.
 */
export function buildManifest(scenario: Scenario, repos: RepoCases) {
  const { params, windows } = scenario;
  const iso = (d: Date) => d.toISOString();
  return {
    manifestVersion: 1,
    params: {
      seed: params.seed,
      now: iso(params.now),
      frequency: params.frequency,
      weekday: params.weekday,
      hour: params.hour,
      timezone: params.timezone,
      volume: params.volume,
      prefix: params.prefix,
    },
    contentDigest: contentDigest(scenario),
    windows: {
      slotAt: iso(windows.slotAt),
      current: { start: iso(windows.windowStart), end: iso(windows.windowEnd) },
      previous: { start: iso(windows.prevWindowStart), end: iso(windows.prevWindowEnd) },
    },
    projects: Object.fromEntries(
      scenario.projects.map((p) => [
        p.key,
        {
          id: p.id,
          name: p.plan.name,
          workspace: p.plan.workspace,
          gitRepo: p.plan.gitRepo,
          rows: { traces: p.data.traces.length, spans: p.data.spans.length },
          expected: { current: p.metrics.cur, previous: p.metrics.prev },
          signals: p.signals.map((s) => ({
            id: s.id,
            title: s.title,
            status: s.status,
            firstSeenAt: iso(s.firstSeenAt),
            resolvedAt: s.resolvedAt ? iso(s.resolvedAt) : null,
            hitsCurrent: s.hits.cur,
            hitsPrevious: s.hits.prev,
          })),
        },
      ]),
    ),
    plantedChanges: scenario.changes,
    controls: scenario.controls,
    derivedEffects: [
      "claude-sonnet-4-5 cost falls with the checkout_agent volume drop (a consequence, not a separate change)",
      "lookup_order calls fall with the same volume drop",
      "Project-level totals move because the planted changes add up; the digest should explain them by the planted entities",
    ],
    /** Entities, per project, whose numbers move only as a consequence of a planted change or by design of the case. */
    derivedEntities: {
      main: ["model:claude-sonnet-4-5", "tool:lookup_order"],
      nogit: ["tool:lookup_invoice"],
      tiny: ["workflow:tiny_agent", "tool:tiny_new_tool"],
      empty: [],
      cloneslow: ["tool:search_docs"],
      clonebig: ["tool:search_docs"],
      clonedead: ["tool:search_docs"],
      other: [
        "workflow:tenantb_marker_agent",
        "model:tenantb-secret-model-9",
        "tool:tenantb_vault_tool",
      ],
    },
    signalsRollup: {
      project: scenario.projects.find((p) => p.key === "main")!.id,
      new: scenario.projects
        .find((p) => p.key === "main")!
        .signals.filter((s) => s.id.endsWith("new-a") || s.id.endsWith("new-b"))
        .map((s) => s.id),
      resolved: scenario.projects
        .find((p) => p.key === "main")!
        .signals.filter((s) => s.id.endsWith("resolved"))
        .map((s) => s.id),
      spiking: scenario.projects
        .find((p) => p.key === "main")!
        .signals.filter((s) => s.id.endsWith("spiking"))
        .map((s) => s.id),
      control: scenario.projects
        .find((p) => p.key === "main")!
        .signals.filter((s) => s.id.endsWith("control"))
        .map((s) => s.id),
    },
    noiseCases: {
      tinySample: scenario.projects.find((p) => p.key === "tiny")!.id,
      emptyWindows: scenario.projects.find((p) => p.key === "empty")!.id,
    },
    isolation: {
      otherTenantProject: scenario.projects.find((p) => p.key === "other")!.id,
      markers: [
        "tenantb_marker_agent",
        "tenantb-secret-model-9",
        "tenantb_vault_tool",
        "TENANTB-MARKER",
      ],
    },
    injection: INJECTION_MARKERS,
    code: {
      repo: SEEDED_REPO,
      oversizeRepo: OVERSIZE_REPO,
      commits: scenario.commits.map((c) => ({
        key: c.key,
        sha: c.sha,
        at: iso(c.at),
        message: c.message,
        pr: c.pr ?? null,
        tag: c.tag ?? null,
        files: Object.keys(c.files).sort(),
      })),
      expectedJoin: {
        badRef:
          "traffic on the bad ref shows the research_agent error-rate rise and the new refund_lookup tool",
        controlRef: "traffic on the ctl ref shows no shift against base",
        noGitContext: scenario.projects.find((p) => p.key === "nogit")!.id,
      },
      repos,
      unreachableUrl: UNREACHABLE_REPO_URL,
    },
  };
}
