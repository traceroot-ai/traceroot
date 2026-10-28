// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

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
vi.mock("@/components/github/GitHubConnectButton", () => ({
  GitHubConnectButton: () => <div data-testid="github-connect" />,
}));
vi.mock("@/components/slack/SlackConnectButton", () => ({
  SlackConnectButton: () => <div data-testid="slack-connect" />,
}));
// A stand-in for the key form, so that its absence from this page is something
// a query can see rather than something inferred from missing text.
vi.mock("./ModelProviderBlock", () => ({
  ModelProviderBlock: () => <div data-testid="model-provider-block" />,
}));

import { GettingStarted } from "./index";

afterEach(() => {
  cleanup();
  projectQuery.data = { workspace_id: "ws_1" };
  projectQuery.isLoading = false;
});

const pickStack = (name: string) => fireEvent.click(screen.getByRole("radio", { name }));
const pickMode = (name: string) => fireEvent.click(screen.getByRole("button", { name }));

/** Document order, so "below" is asserted rather than read off the markup. */
function isAbove(first: Element, second: Element): boolean {
  return Boolean(first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING);
}

describe("the empty traces page", () => {
  it("is the heading and the two tabs, with no stack picker above them", () => {
    const { container } = render(<GettingStarted projectId="proj_1" />);
    expect(screen.getByRole("heading", { name: "Get started with tracing" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Using AI" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Manual" })).toBeTruthy();

    expect(screen.queryByText("Select your stack")).toBeNull();
    expect(screen.queryByRole("radiogroup")).toBeNull();
    expect(container.textContent).not.toContain("Pick what you are building on");
  });

  it("opens on the setup command", () => {
    render(<GettingStarted projectId="proj_1" />);
    expect(screen.getByText("Run this in your project")).toBeTruthy();
    expect(screen.queryByText("2. Install SDK")).toBeNull();
  });

  it("asks for no model key on either tab", () => {
    // The key is asked for during onboarding, not here.
    render(<GettingStarted projectId="proj_1" />);
    expect(screen.queryByText(/model key/i)).toBeNull();
    expect(screen.queryByTestId("model-provider-block")).toBeNull();

    pickMode("Manual");
    expect(screen.queryByText(/model key/i)).toBeNull();
    expect(screen.queryByTestId("model-provider-block")).toBeNull();
  });
});

describe("the manual tab", () => {
  it("picks the stack itself, as step 4, below the switch", () => {
    render(<GettingStarted projectId="proj_1" />);
    pickMode("Manual");

    const steps = screen
      .getAllByText(/^\d+\. /)
      .map((node) => node.textContent?.replace(/^\d+\. /, ""));
    expect(steps).toEqual([
      "Create an API key",
      "Install SDK",
      "Set environment variables",
      "Select your integration",
      "Initialize TraceRoot for OpenAI",
      "External integrations",
    ]);
    expect(
      isAbove(
        screen.getByRole("button", { name: "Manual" }),
        screen.getByRole("radiogroup", { name: "Integration" }),
      ),
    ).toBe(true);
  });

  it("drives the snippet and the docs link off that picker", () => {
    const { container } = render(<GettingStarted projectId="proj_1" />);
    pickMode("Manual");
    pickStack("CrewAI");

    expect(screen.getByText("5. Initialize TraceRoot for CrewAI")).toBeTruthy();
    // The snippet's body, not its heading: the heading would still read "for
    // CrewAI" over OpenAI's code.
    expect(container.textContent).toContain("Integration.CREWAI");
    expect(screen.getByRole("link", { name: "View CrewAI docs" }).getAttribute("href")).toBe(
      "https://traceroot.ai/docs/integrations/crewai",
    );
  });

  it("takes the picker with it when the reader switches back", () => {
    render(<GettingStarted projectId="proj_1" />);
    pickMode("Manual");
    expect(screen.getAllByRole("radiogroup").length).toBeGreaterThan(0);

    pickMode("Using AI");
    expect(screen.queryByRole("radiogroup")).toBeNull();
    expect(screen.getByText("Run this in your project")).toBeTruthy();
  });
});

describe("a workspace that cannot be read", () => {
  it("says so once on each tab, for the external integrations", () => {
    projectQuery.isLoading = false;
    projectQuery.data = undefined;
    render(<GettingStarted projectId="proj_1" />);
    expect(screen.getAllByText(/workspace could not be loaded/)).toHaveLength(1);
    expect(screen.queryByTestId("github-connect")).toBeNull();

    pickMode("Manual");
    expect(screen.getAllByText(/workspace could not be loaded/)).toHaveLength(1);
    expect(screen.queryByTestId("github-connect")).toBeNull();
    // The stack picker needs no workspace, so it is still usable.
    expect(screen.getByRole("radiogroup", { name: "Integration" })).toBeTruthy();
  });

  it("holds the integrations behind a placeholder while the project loads", () => {
    projectQuery.isLoading = true;
    projectQuery.data = undefined;
    render(<GettingStarted projectId="proj_1" />);
    expect(screen.getByText("Loading integrations...")).toBeTruthy();
    expect(screen.queryByText("Loading model providers...")).toBeNull();

    pickMode("Manual");
    expect(screen.getByText("Loading integrations...")).toBeTruthy();
    expect(screen.queryByText("Loading model providers...")).toBeNull();
  });
});
