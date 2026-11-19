import { describe, expect, it } from "vitest";
import type { Workspace } from "@/types/api";
import { resolveSetupNeed } from "../account-setup";

function workspace(fields: Partial<Workspace>): Workspace {
  return {
    id: "ws-own",
    name: "Acme",
    role: "ADMIN",
    project_count: 0,
    create_time: "2026-10-01T00:00:00Z",
    ...fields,
  };
}

// Shaped like GET /api/workspaces answers it for the public demo: `is_demo`,
// listed last, and every account a VIEWER of it. It always has a project, which
// is what would mark a new account as set up if it counted.
const DEMO = workspace({
  id: "ws-demo",
  name: "TraceRoot Demo",
  role: "VIEWER",
  project_count: 1,
  is_demo: true,
});

describe("resolveSetupNeed", () => {
  it("asks an account that is only in the demo for a workspace of its own", () => {
    expect(resolveSetupNeed([DEMO])).toEqual({ kind: "workspace" });
  });

  it("asks for a project in the account's own empty workspace, whatever the demo holds", () => {
    expect(resolveSetupNeed([workspace({}), DEMO])).toEqual({
      kind: "project",
      workspaceId: "ws-own",
      workspaceName: "Acme",
    });
  });

  it("needs nothing once the account's own workspace has a project", () => {
    expect(resolveSetupNeed([workspace({ project_count: 1 }), DEMO])).toBeNull();
  });

  it("never offers the demo as the place for a project, even to its admins", () => {
    // Our team are ADMINs of the demo, so its role alone would make it addable.
    // An empty demo is not a real state; it is the one that isolates the lookup.
    expect(resolveSetupNeed([{ ...DEMO, role: "ADMIN", project_count: 0 }])).toEqual({
      kind: "workspace",
    });
  });
});
