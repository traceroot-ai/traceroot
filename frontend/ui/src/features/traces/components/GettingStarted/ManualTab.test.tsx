// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, cleanup, screen } from "@testing-library/react";

// The CLI card is the unit under test; mock the surrounding hooks and side-effecting
// children so the tab renders without a query client or network access.
vi.mock("@/features/projects/hooks", () => ({
  useProject: () => ({ data: { workspace_id: "ws_1" } }),
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
});

describe("ManualTab", () => {
  it("consolidates the optional extras (incl. CLI) into step 5", () => {
    const { container } = render(<ManualTab projectId="proj_1" />);
    expect(screen.getByText("5. Optional next steps")).toBeDefined();
    expect(screen.getByTestId("github-connect")).toBeDefined();
    expect(screen.getByTestId("slack-connect")).toBeDefined();
    // Manual tab passes includeCli, so the CLI verify row is present.
    expect(container.textContent ?? "").toContain("npm install -g traceroot-cli");
  });
});
