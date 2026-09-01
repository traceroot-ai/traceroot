import { describe, expect, it } from "vitest";
import type { BeforeToolCallContext } from "@earendil-works/pi-agent-core";
import {
  APPROVAL_REQUIRED_REASON,
  CONFIRMATION_UNAVAILABLE_REASON,
  createWritePolicyHook,
  writePolicyHook,
} from "../write-policy.js";

function contextFor(toolName: string): BeforeToolCallContext {
  return { toolCall: { name: toolName } } as unknown as BeforeToolCallContext;
}

describe("writePolicyHook", () => {
  it("lets tools without a registry policy proceed (read, sandbox, github)", async () => {
    for (const name of ["list_traces", "bash", "git_clone", "not_a_registered_tool"]) {
      await expect(writePolicyHook(contextFor(name))).resolves.toBeUndefined();
    }
  });

  it('lets writes with approvalClass "none" proceed', async () => {
    const hook = createWritePolicyHook([
      {
        name: "touch_nothing",
        policy: { approvalClass: "none", minRole: "MEMBER", tenancy: "project" },
      },
    ]);
    await expect(hook(contextFor("touch_nothing"))).resolves.toBeUndefined();
  });

  it('blocks approvalClass "confirm" saying confirmation is not wired up yet', async () => {
    const hook = createWritePolicyHook([
      {
        name: "create_detector",
        policy: { approvalClass: "confirm", minRole: "MEMBER", tenancy: "project" },
      },
    ]);
    await expect(hook(contextFor("create_detector"))).resolves.toEqual({
      block: true,
      reason: CONFIRMATION_UNAVAILABLE_REASON,
    });
  });

  it('blocks the five registry creates (now "confirm") with the confirmation reason', async () => {
    // All five curated creates carry approvalClass "confirm" in the registry.
    for (const name of ["create_workspace", "create_detector", "create_widget"]) {
      await expect(writePolicyHook(contextFor(name))).resolves.toEqual({
        block: true,
        reason: CONFIRMATION_UNAVAILABLE_REASON,
      });
    }
  });

  it('blocks approvalClass "approval" with the fail-closed reason', async () => {
    const hook = createWritePolicyHook([
      { name: "list_traces" },
      {
        name: "delete_detector",
        policy: { approvalClass: "approval", minRole: "MEMBER", tenancy: "project" },
      },
    ]);
    await expect(hook(contextFor("delete_detector"))).resolves.toEqual({
      block: true,
      reason: APPROVAL_REQUIRED_REASON,
    });
    // The read entry in the same list still proceeds.
    await expect(hook(contextFor("list_traces"))).resolves.toBeUndefined();
  });

  it("blocks unknown future approval classes fail-closed, not just the known ones", async () => {
    const hook = createWritePolicyHook([
      {
        name: "purge_everything",
        policy: {
          approvalClass: "some_future_class" as never,
          minRole: "ADMIN",
          tenancy: "workspace",
        },
      },
    ]);
    await expect(hook(contextFor("purge_everything"))).resolves.toEqual({
      block: true,
      reason: APPROVAL_REQUIRED_REASON,
    });
  });
});
