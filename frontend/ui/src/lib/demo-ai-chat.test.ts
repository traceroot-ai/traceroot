import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const env = vi.hoisted(() => ({
  DEMO_WORKSPACE_ID: "ws_demo" as string | undefined,
  DEMO_AI_DAILY_MESSAGE_LIMIT: 5,
  DEMO_AI_MODEL: "claude-haiku-4-5",
}));
vi.mock("@/env", () => ({ env }));

const countMock = vi.fn();
vi.mock("@traceroot/core", () => {
  const order = { VIEWER: 0, MEMBER: 1, ADMIN: 2 } as const;
  return {
    prisma: { aIMessage: { count: (...args: unknown[]) => countMock(...args) } },
    ModelSource: { SYSTEM: "system", BYOK: "byok" },
    Role: { VIEWER: "VIEWER", MEMBER: "MEMBER", ADMIN: "ADMIN" },
    hasMinRole: (role: keyof typeof order, min: keyof typeof order) => order[role] >= order[min],
  };
});

import { decideDemoChat } from "./demo-ai-chat";
import type { Role } from "@traceroot/core";

const NOW = new Date("2026-10-14T15:30:00Z");

function decide(workspaceId: string, role: string) {
  return decideDemoChat({ workspaceId, userId: "u1", role: role as Role, now: NOW });
}

// isDemoWorkspace (lib/demo-workspace.ts) reads process.env at call time.
function setDemoWorkspace(id: string | undefined) {
  env.DEMO_WORKSPACE_ID = id;
  if (id === undefined) delete process.env.DEMO_WORKSPACE_ID;
  else process.env.DEMO_WORKSPACE_ID = id;
}

afterEach(() => {
  delete process.env.DEMO_WORKSPACE_ID;
});

beforeEach(() => {
  setDemoWorkspace("ws_demo");
  env.DEMO_AI_DAILY_MESSAGE_LIMIT = 5;
  env.DEMO_AI_MODEL = "claude-haiku-4-5";
  countMock.mockReset();
});

describe("decideDemoChat", () => {
  it("does not restrict any workspace when no demo workspace is set", async () => {
    setDemoWorkspace(undefined);
    expect(await decide("ws_demo", "VIEWER")).toEqual({ kind: "unrestricted" });
    expect(countMock).not.toHaveBeenCalled();
  });

  it("does not restrict a viewer in a normal workspace", async () => {
    expect(await decide("ws_customer", "VIEWER")).toEqual({ kind: "unrestricted" });
    expect(countMock).not.toHaveBeenCalled();
  });

  it("does not restrict members and admins of the demo workspace", async () => {
    expect(await decide("ws_demo", "MEMBER")).toEqual({ kind: "unrestricted" });
    expect(await decide("ws_demo", "ADMIN")).toEqual({ kind: "unrestricted" });
    expect(countMock).not.toHaveBeenCalled();
  });

  it("lets a demo visitor chat on the demo model while under the limit", async () => {
    countMock.mockResolvedValue(4);
    expect(await decide("ws_demo", "VIEWER")).toEqual({
      kind: "limited",
      choice: { model: "claude-haiku-4-5", providerName: undefined, source: "system" },
      remaining: 1,
    });
  });

  it("uses the configured model", async () => {
    env.DEMO_AI_MODEL = "custom-demo-model";
    countMock.mockResolvedValue(0);
    expect(await decide("ws_demo", "VIEWER")).toMatchObject({
      kind: "limited",
      choice: { model: "custom-demo-model" },
    });
  });

  it("blocks a demo visitor with 429 at the limit", async () => {
    countMock.mockResolvedValue(5);
    const decision = await decide("ws_demo", "VIEWER");
    expect(decision.kind).toBe("blocked");
    if (decision.kind === "blocked") {
      expect(decision.status).toBe(429);
      expect(decision.error).toContain("5 AI messages per day");
    }
  });

  it("blocks every message when the limit is 0", async () => {
    env.DEMO_AI_DAILY_MESSAGE_LIMIT = 0;
    countMock.mockResolvedValue(0);
    expect((await decide("ws_demo", "VIEWER")).kind).toBe("blocked");
  });

  it("counts this user's chat and attributed RCA messages since the start of the UTC day", async () => {
    countMock.mockResolvedValue(0);
    await decide("ws_demo", "VIEWER");
    expect(countMock).toHaveBeenCalledWith({
      where: {
        workspaceId: "ws_demo",
        role: "user",
        createTime: { gte: new Date("2026-10-14T00:00:00Z") },
        OR: [
          { kind: "chat", session: { userId: "u1" } },
          { kind: "rca", metadata: { path: ["initiatorUserId"], equals: "u1" } },
        ],
      },
    });
  });
});
