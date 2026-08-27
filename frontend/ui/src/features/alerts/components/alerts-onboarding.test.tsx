// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, cleanup, screen } from "@testing-library/react";

const mocks = vi.hoisted(() => ({
  useProject: vi.fn(),
  useSlackStatus: vi.fn(),
}));

vi.mock("@/features/projects/hooks", () => ({ useProject: mocks.useProject }));
vi.mock("@/features/integrations/hooks/useSlackIntegration", () => ({
  useSlackStatus: mocks.useSlackStatus,
}));

import { AlertsOnboarding } from "./alerts-onboarding";

describe("AlertsOnboarding", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  const withSlack = (slack: unknown) => {
    mocks.useProject.mockReturnValue({ data: { workspace_id: "ws-1" } });
    mocks.useSlackStatus.mockReturnValue({ data: slack });
  };

  it("prompts to connect when Slack is not connected", () => {
    withSlack({ connected: false });
    render(<AlertsOnboarding projectId="proj-1" />);

    expect(screen.getByText("Connect Slack")).toBeTruthy();
    expect(screen.getByRole("link", { name: /connect slack/i }).getAttribute("href")).toBe(
      "/workspaces/ws-1/settings/integrations",
    );
  });

  it("shows the live connection instead of a connect prompt once Slack is set up", () => {
    withSlack({ connected: true, teamName: "Acme", channel: { id: "c1", name: "oncall" } });
    render(<AlertsOnboarding projectId="proj-1" />);

    expect(screen.queryByText("Connect Slack")).toBeNull();
    expect(screen.getByText("Acme")).toBeTruthy();
    expect(screen.getByText(/#oncall/)).toBeTruthy();
    expect(screen.getByText("Ready to receive alerts.")).toBeTruthy();
  });

  it("flags a connected workspace that has not picked a channel", () => {
    withSlack({ connected: true, teamName: "Acme", channel: null });
    render(<AlertsOnboarding projectId="proj-1" />);

    expect(screen.getByText(/No channel selected/)).toBeTruthy();
    expect(
      screen.getByText("Alerts need a channel. Select one in workspace settings."),
    ).toBeTruthy();
    expect(screen.queryByText("Ready to receive alerts.")).toBeNull();
  });

  it("offers no destination row before the workspace is known", () => {
    mocks.useProject.mockReturnValue({ data: undefined });
    mocks.useSlackStatus.mockReturnValue({ data: undefined });
    render(<AlertsOnboarding projectId="proj-1" />);

    expect(screen.queryByText("Connect Slack")).toBeNull();
  });

  it("links the create action at the alert form", () => {
    withSlack({ connected: true, teamName: "Acme", channel: { id: "c1", name: "oncall" } });
    render(<AlertsOnboarding projectId="proj-1" />);

    expect(screen.getByRole("link", { name: /new alert/i }).getAttribute("href")).toBe(
      "/projects/proj-1/alerts/new",
    );
  });

  it("omits deferred and undecided channels", () => {
    withSlack({ connected: false });
    render(<AlertsOnboarding projectId="proj-1" />);

    expect(screen.queryByText(/webhook/i)).toBeNull();
    expect(screen.queryByText(/github/i)).toBeNull();
    expect(screen.queryByText(/email/i)).toBeNull();
  });
});
