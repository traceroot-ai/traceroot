import { createSseParser } from "./sse.js";
import type { FetchLike, TurnTranscript } from "./types.js";

/** The dev stack (or at least the agent service) is not up. */
export class StackNotRunningError extends Error {}

/** A turn did not complete: HTTP failure, an `error` event, or the timeout. */
export class AgentTurnError extends Error {}

const DEFAULT_TURN_TIMEOUT_MS = 180_000;

export interface AgentClientOptions {
  baseUrl: string;
  userId: string;
  workspaceId: string;
  /** Omitted by default, which lets the service pick its own default model. */
  model?: string;
  timeoutMs?: number;
  fetchImpl?: FetchLike;
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

  /** Preflight: the harness refuses to run against a stack that is down. */
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
   * Tool calls are read from the stream rather than from the persisted
   * messages: the service only writes the user text and the accumulated
   * assistant text to `AIMessage`, so `tool_execution_*` events are the sole
   * record of what the model actually invoked.
   */
  async sendMessage(
    projectId: string,
    sessionId: string,
    message: string,
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
        this.runTurn(projectId, sessionId, message, controller.signal),
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
  ): Promise<TurnTranscript> {
    const body: Record<string, unknown> = { message };
    if (this.options.model !== undefined) body.model = this.options.model;

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

    return this.consume(response.body, sessionId, message);
  }

  private async consume(
    body: ReadableStream<Uint8Array>,
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
    };

    const parser = createSseParser();
    const decoder = new TextDecoder();
    const reader = body.getReader();
    // `agent_end` ends the run and is the last frame the service actually
    // sends; `done` is kept because index.ts still tries to write one.
    let ended = false;
    // `turn_end` alone is enough to accept a clean close: the run finished
    // even if the stream was cut before its final frame.
    let sawTurnEnd = false;

    try {
      while (!ended) {
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

          if (frame.event === "turn_end") sawTurnEnd = true;
          if (frame.event === "agent_end" || frame.event === "done") {
            ended = true;
            break;
          }
        }
      }
    } finally {
      await reader.cancel().catch(() => {});
    }

    // A close with no terminal signal at all means the turn was cut short —
    // scoring whatever partial work arrived would be worse than failing.
    if (!ended && !sawTurnEnd) {
      throw new AgentTurnError(
        "the SSE stream closed without agent_end, turn_end or done — the turn did not finish",
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
