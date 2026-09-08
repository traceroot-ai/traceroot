import { REGISTRY } from "@traceroot-ai/tools";
import type {
  CreatedRows,
  EvalPrisma,
  EvalToolCall,
  FetchLike,
  ProjectRows,
  TurnTranscript,
} from "./types.js";

/** Thrown by a scenario assertion; its message is what the scorecard prints. */
export class EvalAssertionError extends Error {}

export function expectThat(condition: boolean, message: string): asserts condition {
  if (!condition) throw new EvalAssertionError(message);
}

/** Every call to `name` the model made, across all of a scenario's turns. */
export function toolCallsNamed(turns: TurnTranscript[], name: string): EvalToolCall[] {
  return turns.flatMap((turn) => turn.toolCalls).filter((call) => call.name === name);
}

/** Every registry tool that changes state, so a read-only turn still counts as "no write". */
const WRITE_TOOL_NAMES = new Set(
  REGISTRY.filter((entry) => entry.method !== "get").map((entry) => entry.name),
);

/** How much of the agent's answer a failure message quotes. */
const ANSWER_EXCERPT_CHARS = 240;

function excerptOf(text: string): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (collapsed.length <= ANSWER_EXCERPT_CHARS) return collapsed;
  return `${collapsed.slice(0, ANSWER_EXCERPT_CHARS)}…`;
}

/**
 * Why `name` produced no call.
 *
 * An agent that answered without writing anything asked instead of acting —
 * a scenario-design problem, not the broken tool a bare "was never called"
 * implies. Quoting the answer tells the two apart without opening the
 * transcript.
 */
function neverCalledMessage(turns: TurnTranscript[], name: string): string {
  const answer = assistantText(turns).trim();
  const wrote = turns.some((turn) =>
    turn.toolCalls.some((call) => WRITE_TOOL_NAMES.has(call.name)),
  );
  if (wrote || answer.length === 0) return `${name} was never called`;
  return `${name} was never called: the agent answered without calling any write tool — "${excerptOf(answer)}"`;
}

/** The one call to `name`; fails when the model made none or several. */
export function onlyToolCall(turns: TurnTranscript[], name: string): EvalToolCall {
  const calls = toolCallsNamed(turns, name);
  expectThat(calls.length > 0, neverCalledMessage(turns, name));
  expectThat(calls.length === 1, `${name} was called ${calls.length} times; expected exactly one`);
  return calls[0]!;
}

/** The user-visible answer text across a scenario's turns. */
export function assistantText(turns: TurnTranscript[]): string {
  return turns.map((turn) => turn.assistantText).join("\n");
}

// A figure in the reply is a number standing on its own. Digits glued to a
// word or a hyphen are names — p95, gpt-5, w3 — and a name is not a claim
// about the data. Tool results source liberally: any digit run in a result
// can back a figure, so "range 7d" backs a "7 days" in the reply.
const REPLY_FIGURE = /(?<![\w-])\d[\d,]*(?:\.\d+)?(?!\w)/g;
const SOURCE_FIGURE = /\d[\d,]*(?:\.\d+)?/g;

/**
 * Every figure in the reply must appear in some tool result of the same turn:
 * the mechanical form of "never state a number a tool did not return". Dates
 * are figures too, so the check is deliberately strict — a reply that quotes
 * a window's date is fine, since the window came back in the result.
 */
export function noUnsourcedFigures(turns: TurnTranscript[]): void {
  for (const turn of turns) {
    const sourced = new Set(
      turn.toolResults.flatMap((r) => JSON.stringify(r.result).match(SOURCE_FIGURE) ?? []),
    );
    const normalize = (f: string) => f.replace(/,/g, "");
    const sourcedNormalized = new Set([...sourced].map(normalize));
    const unsourced = (turn.assistantText.match(REPLY_FIGURE) ?? []).filter(
      (f) => !sourcedNormalized.has(normalize(f)),
    );
    expectThat(
      unsourced.length === 0,
      `the reply states figures no tool result contained: ${unsourced.join(", ")}`,
    );
  }
}

/** Everything the write tools can create in a project, at one point in time. */
export async function readProjectRows(prisma: EvalPrisma, projectId: string): Promise<ProjectRows> {
  const [detectors, dashboards] = await Promise.all([
    prisma.detector.findMany({ where: { projectId } }),
    prisma.dashboard.findMany({ where: { projectId }, include: { widgets: true } }),
  ]);
  return { detectors, dashboards };
}

/**
 * Rows present in `after` but not `before`.
 *
 * Widgets are diffed by id across every dashboard, so one added to a
 * pre-existing dashboard still reads as newly created.
 */
export function newRows(before: ProjectRows, after: ProjectRows): CreatedRows {
  const detectorIds = new Set(before.detectors.map((row) => row.id));
  const dashboardIds = new Set(before.dashboards.map((row) => row.id));
  const widgetIds = new Set(
    before.dashboards.flatMap((dashboard) => dashboard.widgets.map((widget) => widget.id)),
  );

  return {
    detectors: after.detectors.filter((row) => !detectorIds.has(row.id)),
    dashboards: after.dashboards.filter((row) => !dashboardIds.has(row.id)),
    widgets: after.dashboards
      .flatMap((dashboard) => dashboard.widgets)
      .filter((widget) => !widgetIds.has(widget.id)),
  };
}

/** The single row the scenario was expected to create. */
export function onlyCreated<T extends { id: string }>(rows: T[], label: string): T {
  expectThat(rows.length > 0, `the turn created no ${label}`);
  expectThat(rows.length === 1, `the turn created ${rows.length} ${label}s; expected exactly one`);
  return rows[0]!;
}

export interface ProbeOptions {
  /** The FastAPI backend's base URL. */
  baseUrl: string;
  projectId: string;
  userId: string;
  userEmail?: string;
  /** Width of the query window ending at `now`. */
  windowHours?: number;
  now?: () => Date;
  fetchImpl?: FetchLike;
}

/**
 * Run a stored widget spec through the backend's query route and report the
 * status. This is the same call the dashboard makes to render a widget, so a
 * 200 means the spec really is renderable; empty data is fine and expected on
 * a fixture project with no traces.
 */
export async function probeWidgetQuery(spec: unknown, options: ProbeOptions): Promise<number> {
  const fetchImpl = options.fetchImpl ?? ((url, init) => fetch(url, init));
  const end = (options.now ?? (() => new Date()))();
  const start = new Date(end.getTime() - (options.windowHours ?? 24) * 60 * 60 * 1000);

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "x-user-id": options.userId,
  };
  if (options.userEmail) headers["x-user-email"] = options.userEmail;

  const response = await fetchImpl(
    `${options.baseUrl.replace(/\/+$/, "")}/projects/${options.projectId}/widgets/query`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({
        spec,
        start_time: start.toISOString(),
        end_time: end.toISOString(),
      }),
    },
  );

  return response.status;
}
