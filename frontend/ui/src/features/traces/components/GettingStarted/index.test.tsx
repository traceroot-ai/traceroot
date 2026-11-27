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
vi.mock("@/features/workspaces/hooks", () => ({
  useWorkspaces: () => ({ data: [] }),
  useWorkspace: () => ({ data: { role: "MEMBER" } }),
}));

const { capture } = vi.hoisted(() => ({ capture: vi.fn() }));
vi.mock("posthog-js/react", () => ({ usePostHog: () => ({ capture }) }));

import type { TraceWait } from "@/lib/hooks/use-trace-wait";
import { GettingStarted as Panel } from "./index";

const WAITING: TraceWait = { kind: "waiting" };
const GettingStarted = ({ projectId, wait = WAITING }: { projectId: string; wait?: TraceWait }) => (
  <Panel projectId={projectId} wait={wait} />
);

afterEach(() => {
  cleanup();
  capture.mockReset();
  projectQuery.data = { workspace_id: "ws_1" };
  projectQuery.isLoading = false;
});

const pickStack = (name: string) => fireEvent.click(screen.getByRole("radio", { name }));
const pickMode = (name: string) => fireEvent.click(screen.getByRole("tab", { name }));

/** Document order, so "below" is asserted rather than read off the markup. */
function isAbove(first: Element, second: Element): boolean {
  return Boolean(first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING);
}

describe("the empty traces page", () => {
  it("is the heading and the two tabs, with no stack picker above them", () => {
    const { container } = render(<GettingStarted projectId="proj_1" />);
    expect(screen.getByRole("heading", { name: "Get started with tracing" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Using AI" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Manual" })).toBeTruthy();

    expect(screen.queryByText("Select your stack")).toBeNull();
    expect(screen.queryByRole("radiogroup")).toBeNull();
    expect(container.textContent).not.toContain("Pick what you are building on");
  });

  it("records a change of tab, and not a click on the tab already showing", () => {
    render(<GettingStarted projectId="proj_1" />);

    pickMode("Using AI");
    pickMode("Manual");
    pickMode("Using AI");

    expect(capture.mock.calls).toEqual([
      ["setup_route_chosen", { project_id: "proj_1", surface: "project", route: "manual" }],
      ["setup_route_chosen", { project_id: "proj_1", surface: "project", route: "command" }],
    ]);
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

    pickMode("Manual");
    expect(screen.queryByText(/model key/i)).toBeNull();
  });
});

describe("the first trace", () => {
  it("says the page is watching for it, as the end of sign-up does", () => {
    render(<GettingStarted projectId="proj_1" />);
    expect(screen.getByRole("status").textContent).toBe(
      "Waiting for your first trace. This page updates when it arrives.",
    );
  });

  it("says it arrived and links to it, for the moment before the page opens it", () => {
    render(
      <GettingStarted
        projectId="proj_1"
        wait={{ kind: "found", found: { projectId: "proj_1", traceId: "t_1" } }}
      />,
    );
    expect(screen.getByRole("status").textContent).toContain(
      "Your first trace arrived. Opening it…",
    );
    expect(screen.getByRole("link", { name: "View it" }).getAttribute("href")).toBe(
      "/projects/proj_1/traces?traceId=t_1",
    );
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
      "Initialize traceroot for OpenAI",
      "Run your application",
    ]);
    expect(
      isAbove(
        screen.getByRole("tab", { name: "Manual" }),
        screen.getByRole("radiogroup", { name: "Integration" }),
      ),
    ).toBe(true);
  });

  it("drives the snippet and the docs link off that picker", () => {
    const { container } = render(<GettingStarted projectId="proj_1" />);
    pickMode("Manual");
    pickStack("CrewAI");

    expect(screen.getByText("5. Initialize traceroot for CrewAI")).toBeTruthy();
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
