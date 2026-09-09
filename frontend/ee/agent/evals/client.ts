import { readdir, stat } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { createSseParser } from "./sse.js";
import type { FetchLike, TurnTranscript } from "./types.js";

/** The dev stack (or at least the agent service) is not up. */
export class StackNotRunningError extends Error {}

/** A turn did not complete: HTTP failure, an `error` event, or the timeout. */
export class AgentTurnError extends Error {}

const DEFAULT_TURN_TIMEOUT_MS = 180_000;

/** The agent package root, resolved from this file (`evals/`). */
const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
/**
 * Everything the running service loads as source: its own package and the
 * workspace packages it imports, whose edits reach it just the same.
 */
const SERVICE_SOURCE_DIRS = [
  join(PACKAGE_ROOT, "src"),
  join(PACKAGE_ROOT, "..", "..", "packages", "tools", "src"),
  join(PACKAGE_ROOT, "..", "..", "packages", "core", "src"),
];

/** The most recently modified source file found under a directory. */
export interface SourceChange {
  file: string;
  mtimeMs: number;
}

/**
 * Newest mtime among the `.ts` sources the running service loads
 * (`SERVICE_SOURCE_DIRS`: the agent package and the workspace packages it imports).
 *
 * Tests are skipped: they are not loaded by the running service, so editing
 * one says nothing about whether the process is stale.
 */
export async function newestSourceChange(
  dirs: string | string[] = SERVICE_SOURCE_DIRS,
): Promise<SourceChange | undefined> {
  if (Array.isArray(dirs)) {
    let newest: SourceChange | undefined;
    for (const dir of dirs) {
      const found = await newestSourceChange(dir);
      if (found && (newest === undefined || found.mtimeMs > newest.mtimeMs)) newest = found;
    }
    return newest;
  }
  const dir = dirs;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    // No sources to compare against (a packaged checkout, say) — nothing to
    // assert, and a missing directory must not fail an otherwise fine run.
    return undefined;
  }

  let newest: SourceChange | undefined;
  for (const entry of entries) {
    if (entry.name === "__tests__") continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      const nested = await newestSourceChange(path);
      if (nested && (newest === undefined || nested.mtimeMs > newest.mtimeMs)) newest = nested;
      continue;
    }
    if (!entry.name.endsWith(".ts")) continue;
    const info = await stat(path);
    if (newest === undefined || info.mtimeMs > newest.mtimeMs) {
      newest = { file: path, mtimeMs: info.mtimeMs };
    }
  }
  return newest;
}

function clock(ms: number): string {
  return new Date(ms).toISOString();
}

export interface AgentClientOptions {
  baseUrl: string;
  userId: string;
  workspaceId: string;
  /** Omitted by default, which lets the service pick its own default model. */
  model?: string;
  timeoutMs?: number;
  /**
   * What the harness answers when a confirm-class write parks the run: the
   * eval user approves by default, so write scenarios exercise the real
   * confirmation flow instead of waiting out the turn timeout.
   */
  decision?: "create" | "skip";
  fetchImpl?: FetchLike;
  /**
   * Newest edit to the agent's sources, for the staleness preflight.
   * Defaults to scanning `SERVICE_SOURCE_DIRS`; tests inject their own.
   */
  newestSourceChange?: () => Promise<SourceChange | undefined>;
}

interface PersistedMessage {
  role: string;
  content: string;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** SSE payloads are JSON in practice; keep the raw text if one ever isn't. */
function parseData(data: string): unknown {
  try {
    return JSON.parse(data);
  } catch {
    return data;
  }
}

function errorEventMessage(data: unknown): string {
  const message = (data as { message?: unknown } | null)?.message;
  return typeof message === "string" ? message : JSON.stringify(data);
}

/**
 * Driver for the agent service's HTTP API, scoped to one user + workspace.
 *
 * The message route authorizes by `getSession(sessionId, userId, projectId)`,
 * so every call has to carry the same `x-user-id` — a mismatch surfaces as a
 * 404 rather than a permission error.
 */
export class AgentClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;

  constructor(private readonly options: AgentClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.fetchImpl = options.fetchImpl ?? ((url, init) => fetch(url, init));
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TURN_TIMEOUT_MS;
  }

  private headers(): Record<string, string> {
    return {
      "Content-Type": "application/json",
      "x-user-id": this.options.userId,
      "x-workspace-id": this.options.workspaceId,
    };
  }

  private sessionPath(projectId: string, sessionId?: string): string {
    const base = `${this.baseUrl}/api/v1/projects/${projectId}/sessions`;
    return sessionId === undefined ? base : `${base}/${sessionId}`;
  }

  /**
   * Preflight: the harness refuses to run against a stack that is down — or
   * against one running code older than the working tree.
   *
   * The dev runner re-executes the service in place on every edit, and a
   * reload that fails leaves the process serving its boot-time snapshot. An
   * eval graded against that snapshot reports on code nobody changed, so a
   * source file newer than the service's own boot time is a hard stop.
   */
  async checkHealth(): Promise<void> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/health`);
    } catch (error) {
      throw new StackNotRunningError(
        `agent service unreachable at ${this.baseUrl} (${describe(error)}) — start the dev stack first`,
      );
    }
    if (!response.ok) {
      throw new StackNotRunningError(
        `agent service at ${this.baseUrl} answered /health with ${response.status}`,
      );
    }

    const body = (await response.json().catch(() => null)) as { startedAt?: unknown } | null;
    const startedAt = typeof body?.startedAt === "string" ? Date.parse(body.startedAt) : Number.NaN;
    if (!Number.isFinite(startedAt)) {
      // A service that cannot state its boot time is, by definition, older
      // than the boot time itself — so it cannot be running current code.
      throw new StackNotRunningError(
        `agent service at ${this.baseUrl} reports no startedAt — this service predates the freshness check, so restart it`,
      );
    }

    const scan = this.options.newestSourceChange ?? (() => newestSourceChange());
    const newest = await scan();
    if (newest !== undefined && newest.mtimeMs > startedAt) {
      throw new StackNotRunningError(
        `agent service booted ${clock(startedAt)} but ${relative(PACKAGE_ROOT, newest.file)} ` +
          `changed ${clock(newest.mtimeMs)} — restart it so evals grade current code`,
      );
    }
  }

  async createSession(projectId: string, title?: string): Promise<string> {
    const response = await this.fetchImpl(this.sessionPath(projectId), {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(title === undefined ? {} : { title }),
    });
    if (!response.ok) {
      throw new AgentTurnError(`creating a session failed with ${response.status}`);
    }
    const session = (await response.json()) as { id: string };
    return session.id;
  }

  async getMessages(projectId: string, sessionId: string): Promise<PersistedMessage[]> {
    const response = await this.fetchImpl(`${this.sessionPath(projectId, sessionId)}/messages`, {
      headers: this.headers(),
    });
    if (!response.ok) {
      throw new AgentTurnError(`reading session messages failed with ${response.status}`);
    }
    const body = (await response.json()) as { messages: PersistedMessage[] };
    return body.messages;
  }

  /** Best-effort teardown: a session that is already gone is not an error. */
  async deleteSession(projectId: string, sessionId: string): Promise<void> {
    await this.fetchImpl(this.sessionPath(projectId, sessionId), {
      method: "DELETE",
      headers: this.headers(),
    });
  }

  /**
   * Send one user message and consume the SSE stream to completion.
   *
   * Tool calls are read from the stream so the harness scores exactly what
   * the model invoked live, independent of what the persister keeps (rows are
   * bounded/truncated and land asynchronously).
   */
  async sendMessage(
    projectId: string,
    sessionId: string,
    message: string,
    window?: { range: string },
  ): Promise<TurnTranscript> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;

    // Raced rather than relying on the abort signal alone: the stream is
    // consumed after fetch resolves, so only a race bounds a stalled reader.
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new AgentTurnError(`turn timed out after ${this.timeoutMs}ms`));
      }, this.timeoutMs);
    });

    try {
      return await Promise.race([
        this.runTurn(projectId, sessionId, message, controller.signal, window),
        deadline,
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  private async runTurn(
    projectId: string,
    sessionId: string,
    message: string,
    signal: AbortSignal,
    window?: { range: string },
  ): Promise<TurnTranscript> {
    const body: Record<string, unknown> = { message };
    if (this.options.model !== undefined) body.model = this.options.model;
    // The page's selected range, as the panel sends it with every message.
    if (window !== undefined) body.range = window.range;

    const response = await this.fetchImpl(`${this.sessionPath(projectId, sessionId)}/messages`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(body),
      signal,
    });

    if (!response.ok) {
      throw new AgentTurnError(`sending the message failed with ${response.status}`);
    }
    if (!response.body) {
      throw new AgentTurnError("the message route returned no SSE body");
    }

    return this.consume(response.body, projectId, sessionId, message);
  }

  /** Answer a parked confirm-class call so the run resumes; recorded on the turn. */
  private async decide(turn: TurnTranscript, projectId: string, data: unknown): Promise<void> {
    const pending = (data ?? {}) as {
      decisionId?: unknown;
      toolCallId?: unknown;
      toolName?: unknown;
      args?: unknown;
    };
    if (typeof pending.decisionId !== "string") {
      throw new AgentTurnError("confirmation_pending arrived without a decisionId");
    }
    const action = this.options.decision ?? "create";
    (turn.decisions ??= []).push({
      decisionId: pending.decisionId,
      toolCallId: typeof pending.toolCallId === "string" ? pending.toolCallId : "",
      toolName: typeof pending.toolName === "string" ? pending.toolName : "",
      args: (pending.args ?? {}) as Record<string, unknown>,
      action,
    });
    const response = await this.fetchImpl(
      `${this.sessionPath(projectId, turn.sessionId)}/decisions`,
      {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({ decisionId: pending.decisionId, action }),
      },
    );
    if (!response.ok) {
      throw new AgentTurnError(`answering a confirmation failed with ${response.status}`);
    }
  }

  private async consume(
    body: ReadableStream<Uint8Array>,
    projectId: string,
    sessionId: string,
    message: string,
  ): Promise<TurnTranscript> {
    const turn: TurnTranscript = {
      sessionId,
      message,
      toolCalls: [],
      toolResults: [],
      assistantText: "",
      events: [],
      decisions: [],
    };

    const parser = createSseParser();
    const decoder = new TextDecoder();
    const reader = body.getReader();
    // `agent_end` is pi's own frame and marks the answer complete, but the run
    // is not settled until the service's `done` (run-stream.ts writes it after
    // persistence, immediately before releaseRun) — returning on `agent_end`
    // races the next turn's POST against the still-held run claim, which the
    // messages route answers with a 409. So `agent_end` only marks the turn
    // finished; the loop keeps draining and breaks on `done`.
    // `turn_end` is NOT terminal either: it closes one assistant turn, and the
    // agent may still be looping through tool calls after it.
    let ended = false;
    let terminal = false;

    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;

        for (const frame of parser.push(decoder.decode(chunk.value, { stream: true }))) {
          const data = parseData(frame.data);
          turn.events.push({ event: frame.event, data });

          if (frame.event === "error") {
            throw new AgentTurnError(`agent reported: ${errorEventMessage(data)}`);
          }

          // Accumulate before terminating, so the frames carrying the tool
          // calls and the answer text are never dropped on the way out.
          applyEvent(turn, frame.event, data);

          // A parked write waits for the user; here the harness is the user.
          if (frame.event === "confirmation_pending") {
            await this.decide(turn, projectId, data);
          }

          if (frame.event === "agent_end") ended = true;
          // Only the service's own terminal frame stops the read: `done` is
          // written after the persist chain drains, so by here the run claim
          // is about to be released and the rows the assertions read are
          // flushed. A stream that ends after `agent_end` without ever
          // carrying `done` still passes — run-stream.ts skips the `done`
          // write when persistence throws — it just exits on stream close.
          if (frame.event === "done") {
            ended = true;
            terminal = true;
            break;
          }
        }
        if (terminal) break;
      }
    } finally {
      await reader.cancel().catch(() => {});
    }

    // A close with no terminal frame means the run was cut short — scoring
    // whatever partial work arrived would be worse than failing.
    if (!ended) {
      throw new AgentTurnError(
        "the SSE stream closed without agent_end or done — the turn did not finish",
      );
    }
    return turn;
  }
}

/** Fold one forwarded `AgentEvent` into the turn's transcript. */
function applyEvent(turn: TurnTranscript, event: string, data: unknown): void {
  const payload = data as Record<string, unknown>;

  if (event === "tool_execution_start") {
    turn.toolCalls.push({
      toolCallId: String(payload.toolCallId ?? ""),
      name: String(payload.toolName ?? ""),
      args: (payload.args as Record<string, unknown>) ?? {},
    });
    return;
  }

  if (event === "tool_execution_end") {
    turn.toolResults.push({
      toolCallId: String(payload.toolCallId ?? ""),
      name: String(payload.toolName ?? ""),
      isError: payload.isError === true,
      result: payload.result,
    });
    return;
  }

  if (event === "message_update") {
    // Only user-visible text is scored; thinking deltas are not shown to users.
    const delta = payload.assistantMessageEvent as { type?: string; delta?: string } | undefined;
    if (delta?.type === "text_delta" && typeof delta.delta === "string") {
      turn.assistantText += delta.delta;
    }
  }
}
