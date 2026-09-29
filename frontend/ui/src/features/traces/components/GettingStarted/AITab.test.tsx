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
  it("leads with the one command that does the whole setup", () => {
    const { container } = render(<AITab projectId="proj_1" />);
    expect(screen.getByText("Run this in your project")).toBeDefined();
    expect(container.textContent ?? "").toContain("npx -y traceroot-cli@latest setup");
  });

  it("does not ask for an API key the command creates itself", () => {
    // The old first step was "1. Create an API key", above a widget that did
    // not create one. `traceroot setup` mints it during the browser handoff, so
    // asking here is work the command exists to do — and two places that both
    // create keys drift the first time either changes.
    const { container } = render(<AITab projectId="proj_1" />);
    expect(container.textContent ?? "").not.toContain("Create an API key");
  });

  it("describes the command in two sentences, not a list of stages", () => {
    // A bulleted account of every stage competes with the command for the
    // attention of someone who just wants to know what to paste.
    const { container } = render(<AITab projectId="proj_1" />);
    const text = container.textContent ?? "";
    expect(text).toContain("Instruments your repo with a coding agent");
    expect(container.querySelectorAll("li")).toHaveLength(0);
  });

  it("keeps the sentence that is consent rather than description", () => {
    // The command edits a repository and launches an agent. That is the one
    // line that changes whether somebody pastes it.
    const { container } = render(<AITab projectId="proj_1" />);
    const text = container.textContent ?? "";
    expect(text).toContain("Asks before editing");
    expect(text).toContain("uncommitted changes");
  });

  it("groups GitHub and Slack into the external integrations card", () => {
    render(<AITab projectId="proj_1" />);
    expect(screen.getByText("External integrations")).toBeDefined();
    expect(screen.getByTestId("github-connect")).toBeDefined();
    expect(screen.getByTestId("slack-connect")).toBeDefined();
  });
});
