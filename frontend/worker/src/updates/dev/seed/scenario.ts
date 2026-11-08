import { createHash } from "node:crypto";
import {
  windowsAt,
  type UpdateScheduleSettings,
  type UpdateWindows,
} from "@traceroot/core/updates";
import { planCommits } from "./commits.js";
import { generateProject, type GeneratedProject } from "./generate.js";
import { measureProject, type WindowMetrics } from "./measure.js";
import {
  INJECTION_FILE,
  INJECTION_PR,
  INJECTION_TRACE,
  buildProjectPlans,
  type ProjectKey,
  type ProjectPlan,
} from "./plan.js";
import { hexId } from "./prng.js";
import type { PlantedChange, PlantedControl, SeededCommit, SeededSignal } from "./types.js";

export const DEFAULT_SEED = "update-seed-1";
/** A Monday, 09:30 UTC: half an hour after the weekly slot. */
export const DEFAULT_NOW = "2026-11-02T09:30:00Z";
export const DEFAULT_PREFIX = "seedupd";

export interface SeedParams {
  seed: string;
  now: Date;
  frequency: "daily" | "weekly";
  weekday: number;
  hour: number;
  timezone: string;
  volume: number;
  prefix: string;
}

export function defaultParams(overrides: Partial<SeedParams> = {}): SeedParams {
  return {
    seed: DEFAULT_SEED,
    now: new Date(DEFAULT_NOW),
    frequency: "weekly",
    weekday: 1,
    hour: 9,
    timezone: "UTC",
    volume: 1,
    prefix: DEFAULT_PREFIX,
    ...overrides,
  };
}

export const scheduleOf = (p: SeedParams): UpdateScheduleSettings => ({
  enabled: true,
  frequency: p.frequency,
  weekday: p.weekday,
  hour: p.hour,
  timezone: p.timezone,
});

export const projectIdOf = (prefix: string, key: ProjectKey) => `${prefix}-${key}`;
export const workspaceIdOf = (prefix: string, which: "a" | "b") => `${prefix}-ws-${which}`;

export interface ScenarioProject {
  key: ProjectKey;
  id: string;
  plan: ProjectPlan;
  data: GeneratedProject;
  metrics: Record<"prev" | "cur", WindowMetrics>;
  signals: SeededSignal[];
}

export interface Scenario {
  params: SeedParams;
  windows: UpdateWindows;
  commits: SeededCommit[];
  projects: ScenarioProject[];
  changes: PlantedChange[];
  controls: PlantedControl[];
}

const REF_KEYS = ["base", "bad", "ctl"] as const;

export function planSignals(
  prefix: string,
  key: ProjectKey,
  windows: UpdateWindows,
  data: GeneratedProject,
): SeededSignal[] {
  const cur = windows.windowStart.getTime();
  const len = windows.windowEnd.getTime() - cur;
  const prevStart = windows.prevWindowStart.getTime();
  const prevLen = windows.prevWindowEnd.getTime() - prevStart;
  const failed = (window: "prev" | "cur") =>
    data.meta.filter((m) => m.window === window && m.failed);
  const failedCur = failed("cur");
  const failedPrev = failed("prev");

  const make = (
    name: string,
    title: string,
    spec: {
      status: "open" | "resolved";
      firstSeen: number;
      resolvedAt?: number;
      prev: number;
      cur: number;
      onRef?: string;
    },
  ): SeededSignal => {
    const pool = (list: typeof failedCur) =>
      spec.onRef ? list.filter((m) => m.ref === spec.onRef) : list;
    const times: Date[] = [];
    const traces: string[] = [];
    const lay = (count: number, from: number, span: number, source: typeof failedCur) => {
      for (let i = 0; i < count; i += 1) {
        times.push(new Date(from + Math.floor(((i + 0.5) / count) * span)));
        traces.push(source.length ? source[i % source.length].traceId : hexId(`${name}|${i}`, 32));
      }
    };
    lay(spec.prev, prevStart, prevLen - 120_000, pool(failedPrev));
    const curFrom = Math.max(cur, spec.firstSeen);
    lay(spec.cur, curFrom, cur + len - 120_000 - curFrom, pool(failedCur));
    const sorted = [...times].sort((a, b) => a.getTime() - b.getTime());
    return {
      id: `${prefix}-sig-${key}-${name}`,
      detectorId: `${prefix}-det-${key}`,
      title,
      status: spec.status,
      firstSeenAt: new Date(Math.min(spec.firstSeen, sorted[0]?.getTime() ?? spec.firstSeen)),
      lastSeenAt: sorted[sorted.length - 1] ?? new Date(spec.firstSeen),
      resolvedAt: spec.resolvedAt === undefined ? null : new Date(spec.resolvedAt),
      hits: { cur: spec.cur, prev: spec.prev },
      hitTimes: times,
      hitTraceIds: traces,
    };
  };

  if (key === "main") {
    return [
      make("new-a", "Refund lookup returns server errors", {
        status: "open",
        firstSeen: cur + len * 0.45,
        prev: 0,
        cur: 12,
        onRef: "bad",
      }),
      make("new-b", "Planner retries loop without progress", {
        status: "open",
        firstSeen: cur + len * 0.6,
        prev: 0,
        cur: 4,
        onRef: "bad",
      }),
      make("resolved", "Order lookup times out under load", {
        status: "resolved",
        firstSeen: prevStart - 3 * 86_400_000,
        resolvedAt: cur + len * 0.5,
        prev: 9,
        cur: 2,
      }),
      make("spiking", "Triage routing is slow", {
        status: "open",
        firstSeen: prevStart - 3 * 86_400_000,
        prev: 5,
        cur: 40,
      }),
      make("control", "Docs search misses recent pages", {
        status: "open",
        firstSeen: prevStart - 10 * 86_400_000,
        prev: 20,
        cur: 21,
      }),
    ];
  }
  if (key === "other") {
    return [
      make("marker", "TENANTB-MARKER leaked credentials signal", {
        status: "open",
        firstSeen: cur + len * 0.3,
        prev: 0,
        cur: 10,
      }),
    ];
  }
  return [];
}

export interface CaseShas {
  /** The oversize repository's base commit and the commit that adds its payload. */
  big?: { base: string; payload: string };
}

export function buildScenario(
  params: SeedParams,
  shas: Record<string, string>,
  cases: CaseShas = {},
): Scenario {
  const schedule = scheduleOf(params);
  const windows = windowsAt(schedule, params.now);
  const commits = planCommits(windows).map((c) => ({ ...c, sha: shas[c.key] }));
  const refShas = Object.fromEntries(REF_KEYS.map((k) => [k, shas[k] ?? `unbuilt-${k}`]));
  const shaToKey = Object.fromEntries(Object.entries(refShas).map(([k, v]) => [v, k]));
  void shaToKey;

  const projects: ScenarioProject[] = buildProjectPlans(params.volume).map((plan) => {
    const id = projectIdOf(params.prefix, plan.key);
    // Each project's traces carry the commits of its own repository.
    const projectRefShas =
      plan.key === "clonebig"
        ? {
            base: cases.big?.base ?? hexId("big-base", 40),
            bad: cases.big?.payload ?? hexId("big-payload", 40),
            ctl: hexId("big-ctl", 40),
          }
        : plan.key === "clonedead"
          ? { base: hexId("dead-base", 40), bad: hexId("dead-bad", 40), ctl: hexId("dead-ctl", 40) }
          : refShas;
    const data = generateProject({
      seed: params.seed,
      plan,
      projectId: id,
      windows,
      refShas: projectRefShas,
    });
    const metrics = measureProject(data, plan.gitRepo ? projectRefShas : {});
    return {
      key: plan.key,
      id,
      plan,
      data,
      metrics,
      signals: plan.signals ? planSignals(params.prefix, plan.key, windows, data) : [],
    };
  });

  const { changes, controls } = describeGroundTruth(params, projects);
  return { params, windows, commits, projects, changes, controls };
}

function describeGroundTruth(params: SeedParams, projects: ScenarioProject[]) {
  const byKey = Object.fromEntries(projects.map((p) => [p.key, p]));
  const main = byKey.main;
  const nogit = byKey.nogit;
  const wf = (p: ScenarioProject, name: string, w: "prev" | "cur") => p.metrics[w].byWorkflow[name];
  const model = (p: ScenarioProject, name: string, w: "prev" | "cur") => p.metrics[w].byModel[name];
  const toolCalls = (p: ScenarioProject, name: string, w: "prev" | "cur") =>
    p.metrics[w].byTool[name]?.calls ?? 0;
  const id = (suffix: string) => `${params.prefix}-${suffix}`;

  const changes: PlantedChange[] = [
    {
      id: id("volume-drop-checkout"),
      project: main.id,
      kind: "volume_drop",
      entity: "checkout_agent",
      direction: "down",
      before: wf(main, "checkout_agent", "prev").traces,
      after: wf(main, "checkout_agent", "cur").traces,
      tolerance: 0.1,
      note: "Traces of checkout_agent fall to well under half; its error rate and latency are unchanged.",
    },
    {
      id: id("error-rise-research"),
      project: main.id,
      kind: "error_rate_rise",
      entity: "research_agent",
      direction: "up",
      before: wf(main, "research_agent", "prev").errorRate,
      after: wf(main, "research_agent", "cur").errorRate,
      tolerance: 0.15,
      note: "Failures concentrate on traces from the bad ref, which carries the refund lookup tool.",
    },
    {
      id: id("cost-spike-gpt-4o"),
      project: main.id,
      kind: "cost_spike",
      entity: "gpt-4o",
      direction: "up",
      before: Number(model(main, "gpt-4o", "prev").cost),
      after: Number(model(main, "gpt-4o", "cur").cost),
      tolerance: 0.1,
      note: "analysis_agent sends a much larger prompt on the same number of calls.",
    },
    {
      id: id("latency-shift-triage"),
      project: main.id,
      kind: "latency_shift",
      entity: "triage_agent",
      direction: "up",
      before: wf(main, "triage_agent", "prev").p50Ms,
      after: wf(main, "triage_agent", "cur").p50Ms,
      tolerance: 0.15,
      note: "The median trace duration of triage_agent nearly doubles; volume and errors hold.",
    },
    {
      id: id("new-tool-refund"),
      project: main.id,
      kind: "new_tool",
      entity: "refund_lookup",
      direction: "appeared",
      before: toolCalls(main, "refund_lookup", "prev"),
      after: toolCalls(main, "refund_lookup", "cur"),
      tolerance: 0,
      note: "Called only after the bad release; absent in the previous window.",
    },
    {
      id: id("vanished-tool-legacy"),
      project: main.id,
      kind: "vanished_tool",
      entity: "legacy_search",
      direction: "vanished",
      before: toolCalls(main, "legacy_search", "prev"),
      after: toolCalls(main, "legacy_search", "cur"),
      tolerance: 0,
      note: "Used by analysis_agent in the previous window only.",
    },
    {
      id: id("error-rise-billing"),
      project: nogit.id,
      kind: "error_rate_rise",
      entity: "billing_agent",
      direction: "up",
      before: wf(nogit, "billing_agent", "prev").errorRate,
      after: wf(nogit, "billing_agent", "cur").errorRate,
      tolerance: 0.15,
      note: "A project without git context: the rise cannot be tied to a ref.",
    },
  ];

  const controls: PlantedControl[] = [
    {
      id: id("control-support"),
      project: main.id,
      entity: "support_agent",
      metrics: ["traces", "errorRate", "p50Ms", "p95Ms"],
      note: "Same volume, error rate and latency in both windows; it must not be reported as a change.",
    },
    {
      id: id("control-gpt-4o-mini"),
      project: main.id,
      entity: "gpt-4o-mini",
      metrics: ["calls", "totalTokens", "cost"],
      note: "Used by the control and the latency workflow with unchanged volume and prompts.",
    },
    {
      id: id("control-claude-haiku"),
      project: main.id,
      entity: "claude-haiku-4-5",
      metrics: ["calls", "totalTokens", "cost"],
      note: "Used by research_agent with unchanged volume and prompts.",
    },
    {
      id: id("control-search-docs"),
      project: main.id,
      entity: "search_docs",
      metrics: ["calls"],
      note: "A tool used by several workflows at the same rate in both windows.",
    },
    {
      id: id("control-ref-ctl"),
      project: main.id,
      entity: "ctl",
      metrics: ["errorRate", "p95Ms"],
      note: "A ref merged mid-window whose traffic shows no shift against the base ref.",
    },
    {
      id: id("control-faq"),
      project: nogit.id,
      entity: "faq_agent",
      metrics: ["traces", "errorRate", "p50Ms"],
      note: "Unchanged control in the project without git context.",
    },
  ];
  for (const key of ["cloneslow", "clonebig", "clonedead"] as const) {
    const p = byKey[key];
    changes.push({
      id: id(`error-rise-${key}`),
      project: p.id,
      kind: "error_rate_rise",
      entity: "app_agent",
      direction: "up",
      before: wf(p, "app_agent", "prev").errorRate,
      after: wf(p, "app_agent", "cur").errorRate,
      tolerance: 0.2,
      note: "Failures concentrate on traces from the newest ref of this project's repository.",
    });
  }
  return { changes, controls };
}

export function contentDigest(scenario: Scenario): string {
  const hash = createHash("sha256");
  for (const project of scenario.projects) {
    hash.update(JSON.stringify(project.data.traces));
    hash.update(JSON.stringify(project.data.spans));
    hash.update(JSON.stringify(project.signals));
  }
  return hash.digest("hex");
}

export const INJECTION_MARKERS = {
  trace: INJECTION_TRACE,
  pullRequestTitle: INJECTION_PR,
  repoFile: INJECTION_FILE,
};
