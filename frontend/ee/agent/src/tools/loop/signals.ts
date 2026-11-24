import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { ApiClient, toPiAgentTool } from "@traceroot-ai/tools";
import { INTERNAL_SECRET_HEADER } from "@traceroot/core/agent-service";
import { agentInternalSecret } from "../../internal-secret.js";
import { internalUiUrl } from "../origins.js";
import { requireEntry } from "../registry-tools.js";

/**
 * The signal reads have no internal FastAPI route: the public ones delegate to
 * the web app's secret-authed `project-signals` read, keyed by the resolved
 * project. The agent calls that same read directly. Each tool keeps its
 * registry entry's schema and description; its call becomes that read's POST
 * body, by this map, with the project only ever the run's.
 */
export const SIGNAL_READ_PATH = "/api/internal/project-signals";

type Args = Record<string, unknown>;

const SIGNAL_READ_BODIES = {
  list_signals: (args: Args) => ({
    status: args.status,
    detectorId: args.detector_id,
    limit: args.limit,
    page: args.page,
  }),
  get_signal: (args: Args) => ({ signalId: args.signal_id }),
} satisfies Record<string, (args: Args) => Args>;

interface SignalRow {
  id?: string;
  title?: string;
  status?: string;
  detectorName?: string | null;
  source?: { kind?: string; name?: string | null } | null;
  hitCount?: number;
  reopenCount?: number;
  firstSeenAt?: string;
  lastSeenAt?: string;
  rcaState?: string | null;
  resolvedAt?: string | null;
  mergedIntoId?: string | null;
}

function source(s: SignalRow): string {
  if (s.source?.kind === "loop" && s.source.name) return `loop ${s.source.name}`;
  if (s.source?.kind === "deletedLoop") return "a deleted loop";
  return s.detectorName ? `detector ${s.detectorName}` : "detector";
}

/** The running Loop's own signals' finding keys, by signal id. */
export type FindingKeysBySignal = ReadonlyMap<string, string>;

function signalLine(s: SignalRow, keys: FindingKeysBySignal): string {
  const key = s.id ? keys.get(s.id) : undefined;
  return (
    `- ${s.id} | ${s.status} | ${s.title ?? "(untitled)"} | ${source(s)} | ` +
    (key ? `this loop's key ${key} | ` : "") +
    `${s.hitCount ?? 0} hits, reopened ${s.reopenCount ?? 0}x | ` +
    `first ${s.firstSeenAt ?? "?"}, last ${s.lastSeenAt ?? "?"} | RCA: ${s.rcaState ?? "none"}`
  );
}

export function formatSignalList(data: unknown, keys: FindingKeysBySignal): string {
  const body = (data ?? {}) as { signals?: SignalRow[]; meta?: { total?: number } };
  const signals = Array.isArray(body.signals) ? body.signals : [];
  if (signals.length === 0) return "No signals found.";
  const total = body.meta?.total ? ` (${body.meta.total} total)` : "";
  const lines = signals.map((s) => signalLine(s, keys));
  return `Found ${signals.length} signals${total}:\n${lines.join("\n")}`;
}

export function formatSignalDetail(data: unknown, keys: FindingKeysBySignal): string {
  const s = ((data ?? {}) as { signal?: SignalRow }).signal;
  if (!s) return "Signal not found.";
  const lines = [signalLine(s, keys)];
  if (s.resolvedAt) lines.push(`Resolved at: ${s.resolvedAt}`);
  if (s.mergedIntoId) lines.push(`Merged into: ${s.mergedIntoId}`);
  return lines.join("\n");
}

function signalRead(
  name: keyof typeof SIGNAL_READ_BODIES,
  projectId: string,
  http: ApiClient,
  formatResult: (data: unknown) => string,
): AgentTool<any> {
  const text = (value: string): AgentToolResult<undefined> => ({
    content: [{ type: "text", text: value }],
    details: undefined,
  });
  return {
    // The registry's schema, label and description, with the project hidden.
    ...(toPiAgentTool(requireEntry(name), {
      client: http,
      fixedArgs: { project_id: projectId },
    }) as AgentTool<any>),
    execute: async (_toolCallId, params, signal) => {
      const args: Args = typeof params === "object" && params !== null ? { ...params } : {};
      const fields = Object.entries(SIGNAL_READ_BODIES[name](args));
      const body = {
        projectId,
        ...Object.fromEntries(fields.filter(([, value]) => value !== undefined)),
      };
      try {
        return text(formatResult(await http.request("post", SIGNAL_READ_PATH, { body, signal })));
      } catch (error) {
        // Reported to the model as the registry tools report a failed call.
        const message = error instanceof Error ? error.message : String(error);
        return text(`Error calling ${name}: ${message}`);
      }
    },
  };
}

/** list_signals and get_signal, bound to the run's project; the Loop's own signals show their key. */
export function createSignalReadTools(
  projectId: string,
  findingKeys: FindingKeysBySignal,
  client?: ApiClient,
): AgentTool<any>[] {
  const http =
    client ??
    new ApiClient({
      baseUrl: internalUiUrl(),
      headers: { [INTERNAL_SECRET_HEADER]: agentInternalSecret() },
    });
  return [
    signalRead("list_signals", projectId, http, (data) => formatSignalList(data, findingKeys)),
    signalRead("get_signal", projectId, http, (data) => formatSignalDetail(data, findingKeys)),
  ];
}
