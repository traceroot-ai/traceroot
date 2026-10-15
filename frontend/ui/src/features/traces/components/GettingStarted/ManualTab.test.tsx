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
vi.mock("./ModelProviderBlock", () => ({
  ModelProviderBlock: ({ workspaceId }: { workspaceId: string }) => (
    <div data-testid="model-provider-block" data-workspace={workspaceId} />
  ),
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
  it("groups GitHub and Slack into the external integrations card at step 6", () => {
    render(<ManualTab projectId="proj_1" />);
    expect(screen.getByText("6. External integrations")).toBeDefined();
    expect(screen.getByTestId("github-connect")).toBeDefined();
    expect(screen.getByTestId("slack-connect")).toBeDefined();
  });

  it("offers the model key step after the four that produce a trace", () => {
    // Nothing here is needed to get a trace in, so it sits with the other
    // optional workspace-scoped step rather than ahead of the sequence.
    render(<ManualTab projectId="proj_1" />);
    expect(screen.getByText("5. Use your own model key")).toBeDefined();
    expect(screen.getByTestId("model-provider-block").dataset.workspace).toBe("ws_1");
  });

  it("says both workspace steps are unavailable when the project fetch fails", () => {
    // An errored useProject is not a loading state: isLoading drops with no
    // data behind it. Rendering on `!isLoading` alone gave both steps an empty
    // workspace id, and ModelProviderBlock turns that into a settings link at
    // `/workspaces//settings/model-providers` shown to someone who may be the
    // admin it tells them to find.
    projectQuery.isLoading = false;
    projectQuery.data = undefined;
    render(<ManualTab projectId="proj_1" />);
    expect(screen.queryByTestId("model-provider-block")).toBeNull();
    expect(screen.queryByTestId("github-connect")).toBeNull();
    expect(screen.queryByTestId("slack-connect")).toBeNull();
    expect(screen.getAllByText(/workspace could not be loaded/)).toHaveLength(2);
  });

  it("shows a placeholder instead of the integrations while the project loads", () => {
    // Both workspace-scoped steps read the workspace id off the project, so
    // rendering them before the fetch settles puts rows on screen that cannot
    // act on anything.
    projectQuery.isLoading = true;
    projectQuery.data = undefined;
    render(<ManualTab projectId="proj_1" />);
    expect(screen.getByText("Loading integrations...")).toBeDefined();
    expect(screen.getByText("Loading model providers...")).toBeDefined();
    expect(screen.queryByTestId("github-connect")).toBeNull();
    expect(screen.queryByTestId("model-provider-block")).toBeNull();
  });
});
