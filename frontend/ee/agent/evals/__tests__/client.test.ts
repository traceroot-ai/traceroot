import { describe, expect, it, vi } from "vitest";
import { AgentClient, AgentTurnError, StackNotRunningError } from "../client.js";

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

function makeClient(fetchImpl: ReturnType<typeof vi.fn>) {
  return new AgentClient({
    baseUrl: "http://agent.test",
    userId: "user-1",
    workspaceId: "ws-1",
    fetchImpl: fetchImpl as never,
  });
}

describe("AgentClient.checkHealth", () => {
  it("resolves when the service reports ok", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ status: "ok" }));
    await expect(makeClient(fetchImpl).checkHealth()).resolves.toBeUndefined();
    expect(fetchImpl.mock.calls[0][0]).toBe("http://agent.test/health");
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
