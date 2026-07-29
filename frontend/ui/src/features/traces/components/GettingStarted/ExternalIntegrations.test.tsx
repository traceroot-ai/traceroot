// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, cleanup, screen } from "@testing-library/react";

vi.mock("@/components/github/GitHubConnectButton", () => ({
  GitHubConnectButton: () => <div data-testid="github-connect" />,
}));
vi.mock("@/components/slack/SlackConnectButton", () => ({
  SlackConnectButton: () => <div data-testid="slack-connect" />,
}));

import { ExternalIntegrations } from "./ExternalIntegrations";

afterEach(() => {
  cleanup();
});

describe("ExternalIntegrations", () => {
  it("renders the self-contained GitHub and Slack connect rows with descriptions", () => {
    const { container } = render(<ExternalIntegrations workspaceId="ws_1" />);
    expect(screen.getByTestId("github-connect")).toBeDefined();
    expect(screen.getByTestId("slack-connect")).toBeDefined();
    const text = container.textContent ?? "";
    expect(text).toContain("Install the GitHub App for repository linking");
    expect(text).toContain("Connect Slack to get detector alerts");
  });
});
