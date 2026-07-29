// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { useState } from "react";

// Fake the SSE stream so a test can hold one open mid-turn.
const stream = vi.hoisted(() => ({ active: false }));
vi.mock("./use-ai-stream", () => ({
  useAIStream: () => {
    const [messages, setMessages] = useState<unknown[]>([]);
    return {
      messages,
      isStreaming: stream.active,
      sendMessage: vi.fn(),
      abort: vi.fn(),
      setMessages,
    };
  },
}));

import { useAiChat } from "./use-ai-chat";

// Opening a detector-flagged trace pre-loads an RCA session that a worker fills
// in, so the answer can arrive after the chat is already on screen. Until then
// the chat shows a working indicator, driven by `initialSessionPending`.

type Raw = { id: string; role: "user" | "assistant"; content: string; createTime: string };

function msg(role: "user" | "assistant", content: string, id = `${role}-1`): Raw {
  return { id, role, content, createTime: "2026-01-01T00:00:00Z" };
}

function ok(messages: Raw[]) {
  return { ok: true, json: async () => ({ messages }) };
}

const PROMPT = msg("user", "Analyze this trace");
const ANSWER = msg("assistant", "Root cause: the worker dropped the span.", "a-1");

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  stream.active = false;
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("useAiChat — pre-loaded RCA session working indicator", () => {
  it("keeps the indicator up while the RCA run is pending, then reloads the answer when it completes", async () => {
    fetchMock
      .mockResolvedValueOnce(ok([PROMPT])) // opened while still generating
      .mockResolvedValueOnce(ok([PROMPT, ANSWER])); // reload once the run finishes

    const { result, rerender } = renderHook(
      ({ pending }) =>
        useAiChat({
          projectId: "p1",
          traceId: "t1",
          initialSessionId: "s1",
          initialSessionPending: pending,
        }),
      { initialProps: { pending: true } },
    );

    // Indicator shows immediately, before any messages have loaded.
    expect(result.current.isLoadingSession).toBe(true);
    await waitFor(() => expect(result.current.messages.map((m) => m.role)).toEqual(["user"]));
    expect(result.current.isLoadingSession).toBe(true);

    // Run finishes → status flips → the answer is reloaded and the indicator clears.
    rerender({ pending: false });
    expect(result.current.isLoadingSession).toBe(false);
    await waitFor(() =>
      expect(result.current.messages.map((m) => m.role)).toEqual(["user", "assistant"]),
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("holds the completion reload until the user's own stream has finished", async () => {
    // A reload replaces the whole list, so landing one mid-stream would orphan
    // the message the stream is writing into. It is owed, not dropped.
    fetchMock.mockResolvedValue(ok([PROMPT, ANSWER]));

    const { result, rerender } = renderHook(
      ({ pending }) =>
        useAiChat({
          projectId: "p1",
          traceId: "t1",
          initialSessionId: "s1",
          initialSessionPending: pending,
        }),
      { initialProps: { pending: true } },
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    // The user asks a follow-up while the run is still generating.
    stream.active = true;
    rerender({ pending: true });
    expect(result.current.isStreaming).toBe(true);

    // Run finishes mid-stream — no reload yet.
    rerender({ pending: false });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Their turn ends → the owed reload lands.
    stream.active = false;
    rerender({ pending: false });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  });

  it("shows no indicator and loads once when the RCA answer is already complete on open", async () => {
    fetchMock.mockResolvedValue(ok([PROMPT, ANSWER]));

    const { result } = renderHook(() =>
      useAiChat({
        projectId: "p1",
        traceId: "t1",
        initialSessionId: "s1",
        initialSessionPending: false,
      }),
    );

    expect(result.current.isLoadingSession).toBe(false);
    await waitFor(() => expect(result.current.messages).toHaveLength(2));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
