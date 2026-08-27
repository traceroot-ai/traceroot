import { describe, expect, it } from "vitest";
import type { BeforeToolCallContext } from "@earendil-works/pi-agent-core";
import {
  APPROVAL_REQUIRED_REASON,
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

  it('lets registry writes with approvalClass "none" proceed', async () => {
    // All five currently-curated creates are approval-free in the registry.
    await expect(writePolicyHook(contextFor("create_workspace"))).resolves.toBeUndefined();
    await expect(writePolicyHook(contextFor("create_detector"))).resolves.toBeUndefined();
  });

  it("blocks any other approvalClass with the fail-closed reason", async () => {
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

  it("blocks unknown future approval classes, not just the known one", async () => {
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
