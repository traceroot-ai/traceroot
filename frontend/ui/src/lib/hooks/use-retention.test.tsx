// @vitest-environment jsdom
import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PlanType } from "@traceroot/core";
import { useRetention } from "./use-retention";

const state = vi.hoisted(() => ({
  project: { data: undefined as { workspace_id?: string } | undefined, isPending: true },
  workspace: { data: undefined as { billingPlan?: string } | undefined, isPending: true },
}));

vi.mock("@/features/projects/hooks", () => ({
  useProject: () => state.project,
}));
vi.mock("@/features/workspaces/hooks", () => ({
  useWorkspace: () => state.workspace,
}));

beforeEach(() => {
  state.project = { data: undefined, isPending: true };
  state.workspace = { data: undefined, isPending: true };
});

describe("useRetention", () => {
  it("reports retention as unknown while the project lookup is in flight", () => {
    const { result } = renderHook(() => useRetention("p1"));

    expect(result.current.retentionDays).toBeUndefined();
  });

  it("reports retention as unknown while the workspace lookup is in flight", () => {
    state.project = { data: { workspace_id: "w1" }, isPending: false };

    const { result } = renderHook(() => useRetention("p1"));

    expect(result.current.retentionDays).toBeUndefined();
  });

  it("reports the plan's window once the workspace resolves", () => {
    state.project = { data: { workspace_id: "w1" }, isPending: false };
    state.workspace = { data: { billingPlan: PlanType.PRO }, isPending: false };

    const { result } = renderHook(() => useRetention("p1"));

    expect(result.current.retentionDays).toBe(90);
  });

  it("fails closed for an unrecognized plan string", () => {
    state.project = { data: { workspace_id: "w1" }, isPending: false };
    state.workspace = { data: { billingPlan: "constructor" }, isPending: false };

    const { result } = renderHook(() => useRetention("p1"));

    expect(result.current.retentionDays).toBe(15);
  });

  it("fails closed when the project has no workspace", () => {
    state.project = { data: {}, isPending: false };

    const { result } = renderHook(() => useRetention("p1"));

    expect(result.current.retentionDays).toBe(15);
  });

  it("fails closed when the workspace lookup errors out", () => {
    state.project = { data: { workspace_id: "w1" }, isPending: false };
    state.workspace = { data: undefined, isPending: false };

    const { result } = renderHook(() => useRetention("p1"));

    expect(result.current.retentionDays).toBe(15);
  });
});
