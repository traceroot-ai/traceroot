import { describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, writeFile, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  AgentClient,
  AgentTurnError,
  StackNotRunningError,
  newestSourceChange,
  type SourceChange,
} from "../client.js";

function sseResponse(chunks: string[]): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(stream, { status: 200 });
}

/** An SSE body that stays open forever, so the client's timeout is what ends it. */
function neverEndingResponse(): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("event: message_start\ndata: {}\n\n"));
    },
  });
  return new Response(stream, { status: 200 });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const frame = (event: string, data: unknown) =>
  `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

const textDelta = (delta: string) =>
  frame("message_update", {
    type: "message_update",
    assistantMessageEvent: { type: "text_delta", delta },
  });

/**
 * One real turn as seen when the connection closes right after pi's
 * agent_end, before the service's own `done` write lands: agent_start 1,
 * turn_start 1, message_start 2, message_update 4, message_end 2, turn_end 1,
 * agent_end 1 — and no `done` frame. The client must not depend on `done`.
 */
const REAL_TURN_STREAM = [
  frame("agent_start", { type: "agent_start" }),
  frame("turn_start", { type: "turn_start" }),
  frame("message_start", { type: "message_start", message: { role: "assistant" } }),
  frame("message_update", {
    type: "message_update",
    assistantMessageEvent: { type: "thinking_delta", delta: "considering" },
  }),
  textDelta("Added "),
  frame("message_end", {
    type: "message_end",
    message: { model: "claude-sonnet-4-5", stopReason: "endTurn", usage: { input: 10, output: 4 } },
  }),
  frame("message_start", { type: "message_start", message: { role: "assistant" } }),
  textDelta("the failure "),
  textDelta("detector."),
  frame("message_end", {
    type: "message_end",
    message: { model: "claude-sonnet-4-5", stopReason: "endTurn", usage: { input: 12, output: 6 } },
  }),
  frame("turn_end", { type: "turn_end", toolResults: [] }),
  frame("agent_end", { type: "agent_end", messages: [] }),
].join("");

function makeClient(
  fetchImpl: ReturnType<typeof vi.fn>,
  newest?: () => Promise<SourceChange | undefined>,
) {
  return new AgentClient({
    baseUrl: "http://agent.test",
    userId: "user-1",
    workspaceId: "ws-1",
    fetchImpl: fetchImpl as never,
    // Health preflight compares source mtimes against the service's boot
    // time; unless a test is about staleness, report no sources at all.
    newestSourceChange: newest ?? (async () => undefined),
  });
}

const BOOT = "2026-09-08T10:24:46.000Z";
const healthy = () => jsonResponse({ status: "ok", service: "traceroot-agent", startedAt: BOOT });

// The client reports the changed file relative to the package root, so the
// fixture path has to be a real path under it (evals/__tests__ → ../..).
const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** A source edit at an offset from the service's boot time. */
const changedAt =
  (offsetMs: number, file = join(PACKAGE_ROOT, "src", "prompts", "system.ts")) =>
  async () => ({ file, mtimeMs: Date.parse(BOOT) + offsetMs });

describe("AgentClient.checkHealth", () => {
  it("resolves when the service reports ok", async () => {
    const fetchImpl = vi.fn().mockImplementation(async () => healthy());
    await expect(makeClient(fetchImpl).checkHealth()).resolves.toBeUndefined();
    expect(fetchImpl.mock.calls[0][0]).toBe("http://agent.test/health");
  });

  it("resolves when every source predates the running service", async () => {
    const fetchImpl = vi.fn().mockImplementation(async () => healthy());
    await expect(makeClient(fetchImpl, changedAt(-60_000)).checkHealth()).resolves.toBeUndefined();
  });

  it("refuses to grade a service older than a source edit, naming file and both times", async () => {
    const fetchImpl = vi.fn().mockImplementation(async () => healthy());
    const client = makeClient(fetchImpl, changedAt(100 * 60_000));

    await expect(client.checkHealth()).rejects.toBeInstanceOf(StackNotRunningError);
    await expect(client.checkHealth()).rejects.toThrow(
      /booted 2026-09-08T10:24:46\.000Z but src\/prompts\/system\.ts changed 2026-09-08T12:04:46\.000Z/,
    );
    await expect(client.checkHealth()).rejects.toThrow(/restart it so evals grade current code/);
  });

  it("refuses a service whose /health reports no startedAt at all", async () => {
    const fetchImpl = vi.fn().mockImplementation(async () => jsonResponse({ status: "ok" }));
    const client = makeClient(fetchImpl);

    await expect(client.checkHealth()).rejects.toBeInstanceOf(StackNotRunningError);
    await expect(client.checkHealth()).rejects.toThrow(/predates the freshness check/);
  });

  it("refuses a service whose startedAt is not a parseable instant", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ status: "ok", startedAt: "soon" }));
    await expect(makeClient(fetchImpl).checkHealth()).rejects.toThrow(
      /predates the freshness check/,
    );
  });

  it("throws StackNotRunningError when the service is unreachable", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    await expect(makeClient(fetchImpl).checkHealth()).rejects.toBeInstanceOf(StackNotRunningError);
  });

  it("throws StackNotRunningError on a non-ok status", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ error: "nope" }, 500));
    await expect(makeClient(fetchImpl).checkHealth()).rejects.toBeInstanceOf(StackNotRunningError);
  });
});

describe("newestSourceChange", () => {
  it("returns the newest .ts file, ignoring tests and non-sources", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-src-"));
    await mkdir(join(root, "prompts", "__tests__"), { recursive: true });
    const write = async (path: string, seconds: number) => {
      const full = join(root, path);
      await writeFile(full, "//");
      const when = new Date(Date.parse("2026-09-08T10:00:00.000Z") + seconds * 1000);
      await utimes(full, when, when);
      return full;
    };
    await write("index.ts", 0);
    const newestSource = await write("prompts/system.ts", 60);
    await write("prompts/notes.md", 600);
    await write("prompts/__tests__/system.test.ts", 900);

    const newest = await newestSourceChange(root);

    expect(newest?.file).toBe(newestSource);
    expect(newest?.mtimeMs).toBe(Date.parse("2026-09-08T10:01:00.000Z"));
  });

  it("returns undefined when the directory does not exist", async () => {
    await expect(
      newestSourceChange(join(tmpdir(), "agent-src-missing-xyz")),
    ).resolves.toBeUndefined();
  });
});

describe("AgentClient.createSession", () => {
  it("posts the tenancy headers and returns the new session id", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ id: "sess-9" }, 201));
    const id = await makeClient(fetchImpl).createSession("proj-1", "eval: demo");

    expect(id).toBe("sess-9");
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("http://agent.test/api/v1/projects/proj-1/sessions");
    expect(init.method).toBe("POST");
    expect(init.headers["x-user-id"]).toBe("user-1");
    expect(init.headers["x-workspace-id"]).toBe("ws-1");
    expect(JSON.parse(init.body)).toEqual({ title: "eval: demo" });
  });

  it("throws with the status when session creation fails", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ error: "bad" }, 400));
    await expect(makeClient(fetchImpl).createSession("proj-1")).rejects.toThrow(/400/);
  });
});

describe("AgentClient.sendMessage", () => {
  it("collects tool calls, results and assistant text from the stream", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      sseResponse([
        `event: tool_execution_start\ndata: ${JSON.stringify({
          type: "tool_execution_start",
          toolCallId: "tc-1",
          toolName: "create_detector",
          args: { name: "Failures", template: "failure" },
        })}\n\n`,
        `event: tool_execution_end\ndata: ${JSON.stringify({
          type: "tool_execution_end",
          toolCallId: "tc-1",
          toolName: "create_detector",
          result: { content: [{ type: "text", text: "Created detector" }] },
          isError: false,
        })}\n\n`,
        `event: message_update\ndata: ${JSON.stringify({
          type: "message_update",
          assistantMessageEvent: { type: "text_delta", delta: "Added " },
        })}\n\n`,
        `event: message_update\ndata: ${JSON.stringify({
          type: "message_update",
          assistantMessageEvent: { type: "text_delta", delta: "the detector." },
        })}\n\n`,
        "event: done\ndata: {}\n\n",
      ]),
    );

    const turn = await makeClient(fetchImpl).sendMessage("proj-1", "sess-1", "Add a detector.");

    expect(turn.sessionId).toBe("sess-1");
    expect(turn.message).toBe("Add a detector.");
    expect(turn.toolCalls).toEqual([
      {
        toolCallId: "tc-1",
        name: "create_detector",
        args: { name: "Failures", template: "failure" },
      },
    ]);
    expect(turn.toolResults).toEqual([
      {
        toolCallId: "tc-1",
        name: "create_detector",
        isError: false,
        result: { content: [{ type: "text", text: "Created detector" }] },
      },
    ]);
    expect(turn.assistantText).toBe("Added the detector.");
    expect(turn.events.at(-1)).toEqual({ event: "done", data: {} });
  });

  it("approves a parked confirm-class write so the run resumes, and records the decision", async () => {
    // Writes park on confirmation_pending; without an answer the turn would
    // only end at the timeout. The harness answers as the eval user.
    const pending = {
      type: "confirmation_pending",
      decisionId: "dec-1",
      toolCallId: "tc-1",
      toolName: "create_dashboard",
      args: { label: "Creating it", name: "Probe" },
    };
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        sseResponse([
          `event: tool_execution_start\ndata: ${JSON.stringify({
            type: "tool_execution_start",
            toolCallId: "tc-1",
            toolName: "create_dashboard",
            args: { name: "Probe" },
          })}\n\n`,
          `event: confirmation_pending\ndata: ${JSON.stringify(pending)}\n\n`,
          "event: done\ndata: {}\n\n",
        ]),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));

    const turn = await makeClient(fetchImpl).sendMessage("proj-1", "sess-1", "Create Probe.");

    const [url, init] = fetchImpl.mock.calls[1];
    expect(url).toBe("http://agent.test/api/v1/projects/proj-1/sessions/sess-1/decisions");
    expect(JSON.parse(init.body)).toEqual({ decisionId: "dec-1", action: "create" });
    expect(turn.decisions).toEqual([
      {
        decisionId: "dec-1",
        toolCallId: "tc-1",
        toolName: "create_dashboard",
        args: { label: "Creating it", name: "Probe" },
        action: "create",
      },
    ]);
  });

  it("fails the turn when the decision route rejects the answer", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        sseResponse([
          `event: confirmation_pending\ndata: ${JSON.stringify({ type: "confirmation_pending", decisionId: "dec-1" })}\n\n`,
          "event: done\ndata: {}\n\n",
        ]),
      )
      .mockResolvedValueOnce(new Response("nope", { status: 409 }));
    await expect(makeClient(fetchImpl).sendMessage("proj-1", "sess-1", "x")).rejects.toThrow(
      /answering a confirmation failed with 409/,
    );
  });

  it("posts the message to the session's route with both tenancy headers", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(sseResponse(["event: done\ndata: {}\n\n"]));
    await makeClient(fetchImpl).sendMessage("proj-1", "sess-1", "hi");

    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("http://agent.test/api/v1/projects/proj-1/sessions/sess-1/messages");
    expect(init.headers["x-user-id"]).toBe("user-1");
    expect(init.headers["x-workspace-id"]).toBe("ws-1");
    expect(JSON.parse(init.body)).toEqual({ message: "hi" });
  });

  it("includes the model when one is configured", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(sseResponse(["event: done\ndata: {}\n\n"]));
    const client = new AgentClient({
      baseUrl: "http://agent.test",
      userId: "user-1",
      workspaceId: "ws-1",
      model: "claude-sonnet-4-5",
      fetchImpl: fetchImpl as never,
    });
    await client.sendMessage("proj-1", "sess-1", "hi");

    expect(JSON.parse(fetchImpl.mock.calls[0][1].body)).toEqual({
      message: "hi",
      model: "claude-sonnet-4-5",
    });
  });

  it("ignores thinking deltas so only user-visible text is scored", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      sseResponse([
        `event: message_update\ndata: ${JSON.stringify({
          type: "message_update",
          assistantMessageEvent: { type: "thinking_delta", delta: "hmm" },
        })}\n\n`,
        `event: message_update\ndata: ${JSON.stringify({
          type: "message_update",
          assistantMessageEvent: { type: "text_delta", delta: "done" },
        })}\n\n`,
        "event: done\ndata: {}\n\n",
      ]),
    );

    const turn = await makeClient(fetchImpl).sendMessage("proj-1", "sess-1", "hi");
    expect(turn.assistantText).toBe("done");
  });

  it("rejects with the service's message on an error event", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        sseResponse([`event: error\ndata: ${JSON.stringify({ message: "no API key" })}\n\n`]),
      );

    await expect(makeClient(fetchImpl).sendMessage("proj-1", "sess-1", "hi")).rejects.toThrow(
      /no API key/,
    );
  });

  it("rejects with AgentTurnError when the stream ends without done", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(sseResponse(["event: message_start\ndata: {}\n\n"]));

    await expect(
      makeClient(fetchImpl).sendMessage("proj-1", "sess-1", "hi"),
    ).rejects.toBeInstanceOf(AgentTurnError);
  });

  it("rejects when the message route answers non-2xx", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ error: "session not found" }, 404));
    await expect(makeClient(fetchImpl).sendMessage("proj-1", "sess-1", "hi")).rejects.toThrow(
      /404/,
    );
  });

  it("completes on a stream that closes after agent_end without the service's done frame", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(sseResponse([REAL_TURN_STREAM]));

    const turn = await makeClient(fetchImpl).sendMessage("proj-1", "sess-1", "Add a detector.");

    expect(turn.assistantText).toBe("Added the failure detector.");
    expect(turn.events.at(-1)?.event).toBe("agent_end");
    expect(turn.events.filter((event) => event.event === "done")).toEqual([]);
    // The census counts, so a fixture edit cannot quietly stop being the real shape.
    const census = turn.events.reduce<Record<string, number>>((counts, event) => {
      counts[event.event] = (counts[event.event] ?? 0) + 1;
      return counts;
    }, {});
    expect(census).toEqual({
      agent_start: 1,
      turn_start: 1,
      message_start: 2,
      message_update: 4,
      message_end: 2,
      turn_end: 1,
      agent_end: 1,
    });
  });

  it("drains past agent_end to the service's done, so the run claim is released first", async () => {
    // `agent_end` is pi's frame; the service writes `done` only after the
    // persist chain drains, immediately before it releases the session's run
    // claim. Returning at `agent_end` cancels the read mid-persist and races
    // the next turn's POST into a 409, so the client has to keep reading.
    const fetchImpl = vi.fn().mockResolvedValue(
      sseResponse([
        REAL_TURN_STREAM,
        frame("done", {}),
        // Nothing follows `done`; a frame here would mean the service kept
        // writing after its terminal frame.
      ]),
    );

    const turn = await makeClient(fetchImpl).sendMessage("proj-1", "sess-1", "Add a detector.");

    expect(turn.events.at(-1)).toEqual({ event: "done", data: {} });
    expect(turn.events.filter((event) => event.event === "agent_end")).toHaveLength(1);
    expect(turn.assistantText).toBe("Added the failure detector.");
  });

  it("keeps reading frames the service writes between agent_end and done", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        sseResponse([
          frame("agent_end", { type: "agent_end", messages: [] }),
          textDelta("trailing"),
          frame("done", {}),
        ]),
      );

    const turn = await makeClient(fetchImpl).sendMessage("proj-1", "sess-1", "Add a detector.");

    expect(turn.assistantText).toBe("trailing");
    expect(turn.events.map((event) => event.event)).toEqual([
      "agent_end",
      "message_update",
      "done",
    ]);
  });

  it("captures tool calls on a stream that terminates at agent_end", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      sseResponse([
        frame("tool_execution_start", {
          type: "tool_execution_start",
          toolCallId: "tc-1",
          toolName: "create_detector",
          args: { name: "Failures", template: "failure" },
        }),
        frame("tool_execution_end", {
          type: "tool_execution_end",
          toolCallId: "tc-1",
          toolName: "create_detector",
          result: { content: [{ type: "text", text: "Created detector" }] },
          isError: false,
        }),
        textDelta("Done."),
        frame("agent_end", { type: "agent_end", messages: [] }),
      ]),
    );

    const turn = await makeClient(fetchImpl).sendMessage("proj-1", "sess-1", "hi");

    expect(turn.toolCalls).toEqual([
      {
        toolCallId: "tc-1",
        name: "create_detector",
        args: { name: "Failures", template: "failure" },
      },
    ]);
    expect(turn.toolResults[0]?.isError).toBe(false);
    expect(turn.assistantText).toBe("Done.");
  });

  it("fails a stream that closes after turn_end with no agent_end or done", async () => {
    // turn_end ends one assistant turn, not the run: the agent can still be
    // mid-tool-loop. Accepting it would score a half-finished run as clean,
    // so only agent_end and done terminate.
    const fetchImpl = vi.fn().mockResolvedValue(
      sseResponse([
        `event: message_update\ndata: ${JSON.stringify({
          type: "message_update",
          assistantMessageEvent: { type: "text_delta", delta: "partial" },
        })}\n\n`,
        `event: turn_end\ndata: ${JSON.stringify({ type: "turn_end", toolResults: [] })}\n\n`,
      ]),
    );

    await expect(
      makeClient(fetchImpl).sendMessage("proj-1", "sess-1", "hi"),
    ).rejects.toBeInstanceOf(AgentTurnError);
  });

  it("completes when agent_end follows turn_end, as the real stream does", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        sseResponse([
          `event: turn_end\ndata: ${JSON.stringify({ type: "turn_end", toolResults: [] })}\n\n`,
          frame("agent_end", { type: "agent_end", messages: [] }),
        ]),
      );

    await expect(
      makeClient(fetchImpl).sendMessage("proj-1", "sess-1", "hi"),
    ).resolves.toMatchObject({ sessionId: "sess-1" });
  });

  it("accepts the service's done frame as terminal", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        sseResponse([`event: agent_start\ndata: {}\n\n`, "event: done\ndata: {}\n\n"]),
      );

    await expect(
      makeClient(fetchImpl).sendMessage("proj-1", "sess-1", "hi"),
    ).resolves.toMatchObject({ sessionId: "sess-1" });
  });

  it("fails on an error frame even after a terminal signal already arrived", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        sseResponse([
          `event: turn_end\ndata: ${JSON.stringify({ type: "turn_end" })}\n\n`,
          `event: error\ndata: ${JSON.stringify({ message: "provider exploded" })}\n\n`,
        ]),
      );

    await expect(makeClient(fetchImpl).sendMessage("proj-1", "sess-1", "hi")).rejects.toThrow(
      /provider exploded/,
    );
  });

  it("keeps a non-JSON data payload as raw text rather than failing the turn", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        sseResponse(["event: message_start\ndata: not-json\n\n", "event: done\ndata: {}\n\n"]),
      );

    const turn = await makeClient(fetchImpl).sendMessage("proj-1", "sess-1", "hi");
    expect(turn.events[0]).toEqual({ event: "message_start", data: "not-json" });
  });

  it("rejects when the response carries no stream to read", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    await expect(makeClient(fetchImpl).sendMessage("proj-1", "sess-1", "hi")).rejects.toThrow(
      /no SSE body/,
    );
  });

  it("aborts and rejects once the per-turn timeout elapses", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(neverEndingResponse());
    const client = new AgentClient({
      baseUrl: "http://agent.test",
      userId: "user-1",
      workspaceId: "ws-1",
      timeoutMs: 10,
      fetchImpl: fetchImpl as never,
    });

    await expect(client.sendMessage("proj-1", "sess-1", "hi")).rejects.toThrow(/timed out/i);
  });
});

describe("AgentClient.deleteSession", () => {
  it("deletes and swallows a already-gone session", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ error: "not found" }, 404));
    await expect(makeClient(fetchImpl).deleteSession("proj-1", "sess-1")).resolves.toBeUndefined();
    expect(fetchImpl.mock.calls[0][1].method).toBe("DELETE");
  });
});

describe("AgentClient.getMessages", () => {
  it("returns the persisted messages for a session", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse({ messages: [{ role: "user", content: "hi" }] }));

    await expect(makeClient(fetchImpl).getMessages("proj-1", "sess-1")).resolves.toEqual([
      { role: "user", content: "hi" },
    ]);
  });

  it("throws with the status when the session is not readable", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ error: "not found" }, 404));
    await expect(makeClient(fetchImpl).getMessages("proj-1", "sess-1")).rejects.toThrow(/404/);
  });
});
