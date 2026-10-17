// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, cleanup, screen } from "@testing-library/react";

// The CLI card is the unit under test; mock the surrounding hooks and side-effecting
// children so the tab renders without a query client or network access.
const { projectQuery } = vi.hoisted(() => ({
  projectQuery: { data: { workspace_id: "ws_1" }, isLoading: false } as {
    data?: { workspace_id: string };
    isLoading: boolean;
  },
}));
vi.mock("@/features/projects/hooks", () => ({
  useProject: () => projectQuery,
}));
vi.mock("./ApiKeyBlock", () => ({ ApiKeyBlock: () => <div data-testid="api-key-block" /> }));
vi.mock("./IntegrationPickerCard", () => ({
  IntegrationPickerCard: () => <div data-testid="integration-picker" />,
}));
vi.mock("@/components/github/GitHubConnectButton", () => ({
  GitHubConnectButton: () => <div data-testid="github-connect" />,
}));
vi.mock("@/components/slack/SlackConnectButton", () => ({
  SlackConnectButton: () => <div data-testid="slack-connect" />,
}));

import { ManualTab } from "./ManualTab";

afterEach(() => {
  cleanup();
  projectQuery.data = { workspace_id: "ws_1" };
  projectQuery.isLoading = false;
});

describe("ManualTab", () => {
  it("groups GitHub and Slack into the external integrations card at step 5", () => {
    render(<ManualTab projectId="proj_1" />);
    expect(screen.getByText("5. External integrations")).toBeDefined();
    expect(screen.getByTestId("github-connect")).toBeDefined();
    expect(screen.getByTestId("slack-connect")).toBeDefined();
  });

  it("shows a placeholder instead of the integrations while the project loads", () => {
    // The card reads the workspace id off the project, so rendering it before the
    // fetch settles puts two rows on screen that cannot act on anything.
    projectQuery.isLoading = true;
    projectQuery.data = undefined;
    render(<ManualTab projectId="proj_1" />);
    expect(screen.getByText("Loading integrations...")).toBeDefined();
    expect(screen.queryByTestId("github-connect")).toBeNull();
  });
});
