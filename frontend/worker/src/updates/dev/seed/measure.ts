import { exactQuantile } from "./prng.js";
import type { GeneratedProject, WindowKind } from "./generate.js";
import { nanoToDecimal } from "./generate.js";

export interface GroupStats {
  traces: number;
  errorTraces: number;
  errorRate: number;
  p50Ms: number;
  p95Ms: number;
}

export interface WindowMetrics extends GroupStats {
  llmCalls: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cost: string;
  byModel: Record<string, { calls: number; totalTokens: number; cost: string }>;
  byModelDay: Record<string, { totalTokens: number; cost: string }>;
  byTool: Record<string, { calls: number; errors: number }>;
  byWorkflow: Record<string, GroupStats>;
  byRef: Record<string, GroupStats>;
}

const round6 = (value: number) => Math.round(value * 1e6) / 1e6;

function groupStats(durations: number[], errors: number): GroupStats {
  const traces = durations.length;
  return {
    traces,
    errorTraces: errors,
    errorRate: traces === 0 ? 0 : round6(errors / traces),
    p50Ms: exactQuantile(durations, 0.5),
    p95Ms: exactQuantile(durations, 0.95),
  };
}

function toNano(decimal: string): number {
  const [whole, frac] = decimal.split(".");
  return Number(whole) * 1e9 + Number(frac);
}

/**
 * What an exact aggregate over the generated rows is, per window. These are the
 * numbers the aggregate queries are expected to return, to the digit.
 */
export function measureProject(
  project: GeneratedProject,
  refShas: Record<string, string>,
): Record<WindowKind, WindowMetrics> {
  const windowOf = new Map(project.meta.map((m) => [m.traceId, m.window]));
  const result = {} as Record<WindowKind, WindowMetrics>;

  for (const kind of ["prev", "cur"] as const) {
    const metas = project.meta.filter((m) => m.window === kind);
    const durations = metas.map((m) => m.durationMs);
    const base = groupStats(durations, metas.filter((m) => m.failed).length);

    const byWorkflow: Record<string, GroupStats> = {};
    for (const name of [...new Set(metas.map((m) => m.workflow))].sort()) {
      const group = metas.filter((m) => m.workflow === name);
      byWorkflow[name] = groupStats(
        group.map((m) => m.durationMs),
        group.filter((m) => m.failed).length,
      );
    }
    const byRef: Record<string, GroupStats> = {};
    for (const ref of [
      ...new Set(metas.map((m) => m.ref).filter((r): r is string => r !== null)),
    ].sort()) {
      const group = metas.filter((m) => m.ref === ref);
      byRef[ref] = groupStats(
        group.map((m) => m.durationMs),
        group.filter((m) => m.failed).length,
      );
    }

    let llmCalls = 0;
    let inputTokens = 0;
    let outputTokens = 0;
    let totalTokens = 0;
    let costNano = 0;
    const model: Record<string, { calls: number; totalTokens: number; nano: number }> = {};
    const modelDay: Record<string, { totalTokens: number; nano: number }> = {};
    const tool: Record<string, { calls: number; errors: number }> = {};

    for (const span of project.spans) {
      if (windowOf.get(span.trace_id) !== kind) continue;
      if (span.span_kind === "LLM" && span.model_name) {
        const nano = toNano(span.cost ?? "0.000000000");
        llmCalls += 1;
        inputTokens += span.input_tokens ?? 0;
        outputTokens += span.output_tokens ?? 0;
        totalTokens += span.total_tokens ?? 0;
        costNano += nano;
        const m = (model[span.model_name] ??= { calls: 0, totalTokens: 0, nano: 0 });
        m.calls += 1;
        m.totalTokens += span.total_tokens ?? 0;
        m.nano += nano;
        const day = span.span_start_time.slice(0, 10);
        const md = (modelDay[`${span.model_name}|${day}`] ??= { totalTokens: 0, nano: 0 });
        md.totalTokens += span.total_tokens ?? 0;
        md.nano += nano;
      } else if (span.span_kind === "TOOL") {
        const t = (tool[span.name] ??= { calls: 0, errors: 0 });
        t.calls += 1;
        if (span.status === "ERROR") t.errors += 1;
      }
    }

    const sortKeys = <T>(record: Record<string, T>) =>
      Object.fromEntries(Object.entries(record).sort(([a], [b]) => (a < b ? -1 : 1)));

    result[kind] = {
      ...base,
      llmCalls,
      inputTokens,
      outputTokens,
      totalTokens,
      cost: nanoToDecimal(costNano),
      byModel: sortKeys(
        Object.fromEntries(
          Object.entries(model).map(([k, v]) => [
            k,
            { calls: v.calls, totalTokens: v.totalTokens, cost: nanoToDecimal(v.nano) },
          ]),
        ),
      ),
      byModelDay: sortKeys(
        Object.fromEntries(
          Object.entries(modelDay).map(([k, v]) => [
            k,
            { totalTokens: v.totalTokens, cost: nanoToDecimal(v.nano) },
          ]),
        ),
      ),
      byTool: sortKeys(tool),
      byWorkflow,
      byRef: Object.fromEntries(
        Object.entries(sortKeys(byRef)).map(([ref, stats]) => [refShas[ref] ?? ref, stats]),
      ),
    };
  }
  return result;
}
