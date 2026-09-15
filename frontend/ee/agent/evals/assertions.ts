import { REGISTRY } from "@traceroot-ai/tools";
import type {
  CreatedRows,
  EvalPrisma,
  EvalToolCall,
  EvalToolResult,
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

/**
 * Every registry tool that changes state, so a read-only turn still counts as
 * "no write".
 *
 * The HTTP method alone is not the discriminator: `run_widget_query` is a POST
 * that writes nothing (its policy says so — approvalClass "none"), and
 * counting it would make every scenario that answers a metric question read
 * as a write.
 */
export const WRITE_TOOL_NAMES = new Set(
  REGISTRY.filter((entry) => entry.method !== "get" && entry.policy?.approvalClass !== "none").map(
    (entry) => entry.name,
  ),
);

/** The read tools that take a window, and whose window an assertion checks. */
export const WINDOWED_READ_TOOLS = new Set(["run_widget_query", "get_dashboard_data"]);

/** Every write-tool call across `turns`. */
export function writeToolCalls(turns: TurnTranscript[]): EvalToolCall[] {
  return turns.flatMap((turn) => turn.toolCalls).filter((call) => WRITE_TOOL_NAMES.has(call.name));
}

/** A question about the data answers itself: nothing in `turns` may write. */
export function expectNoWrites(turns: TurnTranscript[], what: string): void {
  const wrote = writeToolCalls(turns);
  expectThat(
    wrote.length === 0,
    `${what} called ${[...new Set(wrote.map((call) => call.name))].join(", ")}; it must write nothing`,
  );
}

/**
 * Every windowed read left the window to the page.
 *
 * The panel sends its picker's range alongside the message, and the tools fall
 * back to the site's 24-hour default when a call names none — so for a message
 * that names no window, a correct read carries either nothing or the page's
 * own range, and never bounds of the model's own choosing.
 */
export function expectPageWindow(turns: TurnTranscript[], range: string): void {
  for (const call of turns.flatMap((turn) => turn.toolCalls)) {
    if (!WINDOWED_READ_TOOLS.has(call.name)) continue;
    expectThat(
      call.args.range === undefined || call.args.range === range,
      `${call.name} asked for range ${JSON.stringify(call.args.range)}; the message named no window, so the page's ${range} has to carry it`,
    );
    expectThat(
      call.args.start_time === undefined && call.args.end_time === undefined,
      `${call.name} pinned its own bounds (${JSON.stringify(call.args.start_time)} → ${JSON.stringify(call.args.end_time)}); the message named no window, so the page's ${range} has to carry it`,
    );
  }
}

/** Every result `name` produced, across a scenario's turns. */
export function toolResultsNamed(turns: TurnTranscript[], name: string): EvalToolResult[] {
  return turns.flatMap((turn) => turn.toolResults).filter((result) => result.name === name);
}

/** A tool result as searchable text; a result with no payload reads as empty. */
export function resultText(result: EvalToolResult): string {
  return JSON.stringify(result.result) ?? "";
}

/**
 * How a reply may write one integer: with or without thousands separators, so
 * "219292", "219,292" and "219 292" all count. Built from the figure rather
 * than typed out, so a change to the seeded dataset cannot leave a stale
 * literal behind in a scenario.
 */
export function figurePattern(value: number): RegExp {
  const digits = String(Math.trunc(Math.abs(value)));
  return new RegExp(digits.replace(/\B(?=(?:\d{3})+$)/g, "[,\\s]?"));
}

/**
 * How a reply may name one UTC date: the ISO form the tool results carry, or
 * either English word order around the month's name, with an optional ordinal
 * suffix — "2026-08-31", "August 31", "Aug 31st", "31 Aug".
 *
 * The month accepts any 3-or-more-letter prefix of its long name, with an
 * optional abbreviating period, because that is how English month
 * abbreviations are actually formed and no single pair of spellings covers
 * them: "Sept 1" sits in the gap between "Sep" and "September". Every en-US
 * short month name is itself such a prefix, so the short form stays covered.
 */
export function dateMentionPattern(isoDate: string): RegExp {
  const day = Number(isoDate.split("-")[2]);
  const at = new Date(`${isoDate}T00:00:00Z`);
  const long = at.toLocaleString("en-US", { month: "long", timeZone: "UTC" });
  // Longest first, so the alternation prefers the fullest spelling it can match.
  const spellings = Array.from({ length: long.length - 2 }, (_, i) =>
    long.slice(0, long.length - i),
  );
  // Longest first, and closed by a period or a word boundary, so "Sept" is read
  // as September rather than as the "Sep" inside some longer word.
  const month = `(?:${spellings.join("|")})(?:\\.|\\b)`;
  const dayNumber = `0?${day}(?:st|nd|rd|th)?(?!\\d)`;
  return new RegExp(`(?:${isoDate}|\\b${month}\\s+${dayNumber}|\\b${dayNumber}\\s+${month})`, "i");
}

/** Whether `text` names `isoDate` in any of those forms. */
export function mentionsDate(text: string, isoDate: string): boolean {
  return dateMentionPattern(isoDate).test(text);
}

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

// A figure in the reply is a number standing on its own, sign included. Digits
// glued to a word or a hyphen are names — p95, gpt-5, w3 — and a name is not
// a claim about the data. Tool results source liberally: any digit run in a
// result can back a figure, so "range 7d" backs a "7 days" in the reply.
const REPLY_FIGURE = /(?<![\w-])(-?\d[\d,]*(?:\.\d+)?)(%?)(?!\w)/g;
const SOURCE_FIGURE = /-?\d[\d,]*(?:\.\d+)?/g;

// Ratio and multiplier notation: "3:1", "6.7x". These numerals spell a
// relation between figures standing next to them, not a metric value the
// tools were asked for. A slash is deliberately not here: "12/500 traces
// failed" is two quantities, and both stay checked. A percentage is not here
// either: it stays a claim unless the reply's own sourced figures in the same
// sentence reconcile it (see below), because "rose 12%" cites a baseline the
// reply never states.
const RATIO_NOTATION = /(?<![\w-])-?\d[\d,]*(?:\.\d+)?\s*(?::\s*-?\d[\d,]*(?:\.\d+)?|x\b|×)/gi;

// Sentence ends: a terminator followed by whitespace or the end, or a line
// break. A decimal point is followed by a digit, so it never ends a sentence.
const SENTENCE_END = /[.!?](?=\s|$)|\n/g;

/** Index of the sentence each character position falls in, for one text. */
function sentenceIndexer(text: string): (at: number) => number {
  const ends = [...text.matchAll(SENTENCE_END)].map((m) => m.index ?? 0);
  return (at) => ends.filter((end) => end < at).length;
}

/** The reply with its ratio notation blanked out, position for position. */
function maskRatioNotation(text: string): string {
  return text.replace(RATIO_NOTATION, (match) => " ".repeat(match.length));
}

// Thousands separators and leading zeros are spelling, not value: "Sep 7" is
// sourced by a "-07" in a date.
const normalizeFigure = (figure: string) => figure.replace(/,/g, "").replace(/^(-?)0+(?=\d)/, "$1");

/**
 * Every figure in the reply must appear in some tool result of the same
 * conversation: the mechanical form of "never state a number a tool did not
 * return". Dates are figures too, so the check is deliberately strict — a
 * reply that quotes a window's date is fine, since the window came back in
 * the result.
 *
 * Sourcing accumulates across the turns of one session, because that is
 * exactly what the model can see: a figure a tool returned on an earlier turn
 * is still in its context, so restating it later is memory, not invention.
 * The set resets when the session id changes, so a scenario that asks the
 * same question in a fresh session still gets each answer judged on its own.
 */
export function noUnsourcedFigures(turns: TurnTranscript[]): void {
  let sessionId: string | undefined;
  let sourcedNormalized = new Set<string>();

  for (const turn of turns) {
    if (turn.sessionId !== sessionId) {
      sessionId = turn.sessionId;
      sourcedNormalized = new Set();
    }
    const sourced =
      // A result with no payload sources nothing (stringify gives undefined).
      turn.toolResults.flatMap((r) => (JSON.stringify(r.result) ?? "").match(SOURCE_FIGURE) ?? []);
    for (const figure of sourced) {
      const normalized = normalizeFigure(figure);
      sourcedNormalized.add(normalized);
      // Liberal both ways: a "-31" pulled out of a date sources "31" as well
      // as "-31"; only the reply side is strict about the sign.
      if (normalized.startsWith("-")) sourcedNormalized.add(normalized.slice(1));
    }

    const masked = maskRatioNotation(turn.assistantText);
    const sentenceOf = sentenceIndexer(masked);
    const matches = [...masked.matchAll(REPLY_FIGURE)].map((m) => ({
      text: m[1]!,
      percent: m[2] === "%",
      sentence: sentenceOf(m.index ?? 0),
    }));
    const isSourced = (f: string) => sourcedNormalized.has(normalizeFigure(f));
    // The figures the reply states and a result backs, per sentence: the only
    // inputs a share in that sentence may be computed from.
    const statedIn = new Map<number, number[]>();
    for (const m of matches) {
      if (!isSourced(m.text)) continue;
      statedIn.set(m.sentence, [
        ...(statedIn.get(m.sentence) ?? []),
        Number(normalizeFigure(m.text)),
      ]);
    }
    // A percentage is never a reading — no widget result returns one — so it can
    // only be arithmetic over figures that were returned. Accept it when the
    // same sentence shows the two sourced figures it reconciles against
    // ("219,292 of 384,412" is "~57%"), to the rounding the reply itself used.
    // A share the sentence's own numbers cannot produce, like "rose 12%",
    // still fails, and every absolute figure stays strictly sourced.
    const reconcilesAsShare = (f: string, sentence: number) => {
      const n = normalizeFigure(f);
      const v = Number(n);
      if (!Number.isFinite(v)) return false;
      const stated = statedIn.get(sentence) ?? [];
      const tolerance = 0.5 * 10 ** -(n.split(".")[1]?.length ?? 0) + 1e-9;
      return stated.some(
        (b) => b !== 0 && stated.some((a) => Math.abs((100 * a) / b - v) <= tolerance),
      );
    };
    const unsourced = matches
      .filter((m) => !isSourced(m.text) && !(m.percent && reconcilesAsShare(m.text, m.sentence)))
      .map((m) => m.text);
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
