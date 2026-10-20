import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { createDownloadSessionTool } from "../download-session.js";
import type { Executor } from "../../executors/interface.js";

// Only writeFile and isReady are exercised here; stub the rest of Executor.
const executor = {
  writeFile: vi.fn().mockResolvedValue(undefined),
  isReady: vi.fn().mockReturnValue(true),
} as unknown as Executor;

describe("createDownloadSessionTool", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each([
    "normal-session",
    "victim-session?x=1#",
    "../../victim-project/sessions/victim-session",
    "..\\..\\victim-project\\sessions\\victim-session",
    "%2e%2e%2fvictim-project%2fsessions%2fvictim-session",
  ])("keeps a model-supplied session ID in one path segment: %s", async (sessionId) => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ traces: [] }) });
    vi.stubGlobal("fetch", fetchMock);

    const tool = createDownloadSessionTool("proj-1", "user-1", executor);
    await tool.execute("call-1", { label: "session", sessionId });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const url = new URL(fetchMock.mock.calls[0][0] as string);
    const prefix = "/api/v1/projects/proj-1/sessions/";
    expect(url.pathname).toBe(`${prefix}${encodeURIComponent(sessionId)}`);
    expect(decodeURIComponent(url.pathname.slice(prefix.length))).toBe(sessionId);
    expect(url.search).toBe("");
    expect(url.hash).toBe("");
  });

  it.each([".", ".."])(
    "rejects a dot segment session ID before fetching: %s",
    async (sessionId) => {
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);

      const tool = createDownloadSessionTool("proj-1", "user-1", executor);
      const result = await tool.execute("call-1", { label: "session", sessionId });

      expect((result.content[0] as { text: string }).text).toContain("Invalid session ID");
      expect(fetchMock).not.toHaveBeenCalled();
      expect(executor.writeFile).not.toHaveBeenCalled();
    },
  );
});
