// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, cleanup, screen } from "@testing-library/react";

vi.mock("@/components/github/GitHubConnectButton", () => ({
  GitHubConnectButton: () => <div data-testid="github-connect" />,
}));
vi.mock("@/components/slack/SlackConnectButton", () => ({
  SlackConnectButton: () => <div data-testid="slack-connect" />,
}));

import { OptionalNextSteps } from "./OptionalNextSteps";

afterEach(() => {
  cleanup();
});

describe("OptionalNextSteps", () => {
  it("renders the self-contained GitHub and Slack connect rows", () => {
    render(<OptionalNextSteps workspaceId="ws_1" />);
    expect(screen.getByTestId("github-connect")).toBeDefined();
    expect(screen.getByTestId("slack-connect")).toBeDefined();
  });

  it("omits the CLI row by default", () => {
    const { container } = render(<OptionalNextSteps workspaceId="ws_1" />);
    expect(container.textContent ?? "").not.toContain("npm install -g traceroot-cli");
  });

  it("includes the CLI verify row when includeCli is set", () => {
    const { container } = render(<OptionalNextSteps workspaceId="ws_1" includeCli />);
    const text = container.textContent ?? "";
    expect(text).toContain("List and inspect traces from your terminal");
    expect(text).toContain("npm install -g traceroot-cli");
    expect(text).toContain("traceroot login");
    expect(text).toContain("traceroot traces list");
    expect(text).toContain("https://app.traceroot.ai");
  });
});
