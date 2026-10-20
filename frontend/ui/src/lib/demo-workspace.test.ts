import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const upsertMock = vi.fn();
vi.mock("@traceroot/core", () => ({
  prisma: { workspaceMember: { upsert: (...args: unknown[]) => upsertMock(...args) } },
  Role: { ADMIN: "ADMIN", MEMBER: "MEMBER", VIEWER: "VIEWER" },
}));

import {
  demoWorkspaceId,
  ensureDemoMembership,
  isDemoWorkspace,
  sortDemoLast,
  userMembershipWhere,
} from "./demo-workspace";

beforeEach(() => {
  upsertMock.mockReset();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("demo workspace off (DEMO_WORKSPACE_ID unset)", () => {
  beforeEach(() => vi.stubEnv("DEMO_WORKSPACE_ID", ""));

  it("has no demo workspace", () => {
    expect(demoWorkspaceId()).toBeNull();
    expect(isDemoWorkspace("ws-any")).toBe(false);
  });

  it("builds the same where for both choices", () => {
    expect(userMembershipWhere("u1", "include-demo")).toEqual({ userId: "u1" });
    expect(userMembershipWhere("u1", "exclude-demo")).toEqual({ userId: "u1" });
  });

  it("does not add anyone to a demo workspace", async () => {
    await ensureDemoMembership("u1");
    expect(upsertMock).not.toHaveBeenCalled();
  });
});

describe("demo workspace on", () => {
  beforeEach(() => vi.stubEnv("DEMO_WORKSPACE_ID", " ws-demo "));

  it("finds the demo workspace by its trimmed id", () => {
    expect(demoWorkspaceId()).toBe("ws-demo");
    expect(isDemoWorkspace("ws-demo")).toBe(true);
    expect(isDemoWorkspace("ws-own")).toBe(false);
  });

  it("leaves the demo out only when the caller asks", () => {
    expect(userMembershipWhere("u1", "include-demo")).toEqual({ userId: "u1" });
    expect(userMembershipWhere("u1", "exclude-demo")).toEqual({
      userId: "u1",
      workspaceId: { not: "ws-demo" },
    });
  });

  it("moves the demo workspace last and keeps the order of the rest", () => {
    const list = [{ id: "a" }, { id: "ws-demo" }, { id: "b" }, { id: "c" }];
    expect(sortDemoLast(list, (w) => w.id).map((w) => w.id)).toEqual(["a", "b", "c", "ws-demo"]);
  });

  it("adds the user as VIEWER and never changes an existing role", async () => {
    upsertMock.mockResolvedValue({});
    await ensureDemoMembership("u1");

    expect(upsertMock).toHaveBeenCalledTimes(1);
    const args = upsertMock.mock.calls[0][0];
    expect(args.where).toEqual({ workspaceId_userId: { workspaceId: "ws-demo", userId: "u1" } });
    // An existing member (for example a team ADMIN) keeps the role it has.
    expect(args.update).toEqual({});
    expect(args.create).toMatchObject({ workspaceId: "ws-demo", userId: "u1", role: "VIEWER" });
  });

  it("logs and does not throw when the database fails, so sign-in never breaks", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    upsertMock.mockRejectedValue(new Error("foreign key: workspace not found"));

    await expect(ensureDemoMembership("u1")).resolves.toBeUndefined();
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });
});
