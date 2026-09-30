// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, cleanup, screen } from "@testing-library/react";
import { ImpersonationError } from "@/lib/api/errors";

const mocks = vi.hoisted(() => ({
  workspace: undefined as { role?: string; billingPlan?: string } | undefined,
  status: { connected: false } as { connected: boolean; teamName?: string; channel?: unknown },
  error: undefined as Error | undefined,
}));

vi.mock("next/navigation", () => ({
  usePathname: () => "/projects/p1",
}));
vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));
vi.mock("@/features/workspaces/hooks", () => ({
  useWorkspace: () => ({ data: mocks.workspace }),
}));
vi.mock("@/features/integrations/hooks/useSlackIntegration", () => ({
  useSlackStatus: () => ({ data: mocks.status, isLoading: false, error: mocks.error }),
  useSlackChannels: () => ({ data: undefined, isLoading: false }),
  useSaveSlackChannel: () => ({ mutate: vi.fn(), isPending: false }),
  useDisconnectSlack: () => ({ mutate: vi.fn(), isPending: false }),
  useSendSlackTest: () => ({ mutate: vi.fn(), isPending: false }),
}));

import { SlackConnectButton } from "./SlackConnectButton";

afterEach(() => {
  cleanup();
  mocks.error = undefined;
});

describe("SlackConnectButton", () => {
  it("does not mistake an impersonation denial for an unconnected integration", () => {
    mocks.workspace = { role: "ADMIN" };
    mocks.error = new ImpersonationError("Integrations cannot be managed while impersonating.");
    render(<SlackConnectButton workspaceId="ws_1" />);
    expect(screen.getByRole("alert").textContent).toContain("while impersonating");
    expect(screen.queryByText("Connect")).toBeNull();
  });
  it("offers Connect (no upgrade gate) for an admin workspace with no billingPlan", () => {
    // Regression for the Slack-on-all-plans change: a missing billingPlan must
    // NOT render an upgrade prompt — the install route/worker default it to
    // "free", which is now entitled. The button must match that.
    mocks.workspace = { role: "ADMIN" };
    mocks.status = { connected: false };

    render(<SlackConnectButton workspaceId="ws_1" />);

    expect(screen.getByText("Connect")).toBeDefined();
    expect(screen.queryByText(/Upgrade to Pro/i)).toBeNull();
    expect(screen.queryByText(/Upgrade/i)).toBeNull();
  });

  it("renders the connected state with the team name", () => {
    mocks.workspace = { role: "ADMIN", billingPlan: "free" };
    mocks.status = { connected: true, teamName: "Acme" };

    render(<SlackConnectButton workspaceId="ws_1" />);

    expect(screen.getByText("Acme")).toBeDefined();
    expect(screen.queryByText(/Upgrade/i)).toBeNull();
  });
});
