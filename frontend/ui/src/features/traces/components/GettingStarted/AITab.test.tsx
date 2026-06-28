// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, cleanup, screen } from "@testing-library/react";

// The CLI card is the unit under test; mock the surrounding hooks and side-effecting
// children so the tab renders without a query client or network access.
vi.mock("@/features/projects/hooks", () => ({
  useProject: () => ({ data: { workspace_id: "ws_1" } }),
}));
vi.mock("./ApiKeyBlock", () => ({ ApiKeyBlock: () => <div data-testid="api-key-block" /> }));
vi.mock("@/components/github/GitHubConnectButton", () => ({
  GitHubConnectButton: () => <div data-testid="github-connect" />,
}));
vi.mock("@/components/slack/SlackConnectButton", () => ({
  SlackConnectButton: () => <div data-testid="slack-connect" />,
}));

import { AITab } from "./AITab";

afterEach(() => {
  cleanup();
});

describe("AITab", () => {
  it("includes the CLI verification card as step 5", () => {
    const { container } = render(<AITab projectId="proj_1" />);
    expect(screen.getByText("5. Verify your traces from the terminal (optional)")).toBeDefined();
    expect(container.textContent ?? "").toContain("npm install -g traceroot-cli");
  });
});
