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
vi.mock("@/components/github/GitHubConnectButton", () => ({
  GitHubConnectButton: () => <div data-testid="github-connect" />,
}));
vi.mock("@/components/slack/SlackConnectButton", () => ({
  SlackConnectButton: () => <div data-testid="slack-connect" />,
}));

import { AITab } from "./AITab";

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  vi.resetModules();
  projectQuery.data = { workspace_id: "ws_1" };
  projectQuery.isLoading = false;
});

/**
 * Renders the tab against a stated deployment.
 *
 * `NEXT_PUBLIC_API_URL` is read through `@/env.client`, which parses it once at
 * module load, so the stub has to be followed by a fresh import of the tab.
 */
async function renderTabWith(apiUrl: string) {
  vi.stubEnv("NEXT_PUBLIC_API_URL", apiUrl);
  vi.resetModules();
  const { AITab: Reloaded } = await import("./AITab");
  return render(<Reloaded projectId="proj_1" />);
}

describe("AITab", () => {
  it("leads with the one command that does the whole setup", () => {
    const { container } = render(<AITab projectId="proj_1" />);
    expect(screen.getByText("Run this in your project")).toBeDefined();
    expect(container.textContent ?? "").toContain("npx -y traceroot-cli@latest setup");
  });

  it("writes the project this panel is showing into the command", () => {
    // The panel knows which project the reader is on; the bare command would
    // ask them, and a multi-project user can answer it wrongly.
    const { container } = render(<AITab projectId="proj_1" />);
    expect(container.textContent ?? "").toContain("setup --project proj_1");
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

  it("shows no runnable command when the deployment's API URL is not an origin", async () => {
    // `NEXT_PUBLIC_API_URL` is `z.string()` with no URL validation, so a value
    // like this reaches the panel. The command rendered for it used to be the
    // unflagged one, which targets TraceRoot Cloud — so a self-hosted reader
    // was handed a confident line that signs in against the wrong deployment.
    const { container } = await renderTabWith("http://:8000");
    const text = container.textContent ?? "";

    expect(text).not.toContain("npx -y traceroot-cli@latest setup");
    // No code block and so no copy button: a command in that frame reads as
    // one to paste whatever the surrounding text says.
    expect(container.querySelector("pre")).toBeNull();
    expect(screen.queryByText("Run this in your project")).toBeNull();
  });

  it("names the variable and its value, which is what the reader can act on", async () => {
    // The person on an empty traces page of a self-hosted install is usually
    // the person who sets this, and the value is already public — it is inlined
    // into this bundle — so showing it discloses nothing new and saves a hunt.
    const { container } = await renderTabWith("http://:8000");
    const text = container.textContent ?? "";

    expect(text).toContain("NEXT_PUBLIC_API_URL");
    expect(text).toContain("http://:8000");
    // Says where a working route is, and promises no repair of its own.
    expect(text).toContain("manual tab");
  });

  it("keeps the command for a deployment the CLI's own default already serves", async () => {
    // The contrasting case: no flags because none are needed, which still has
    // to render the bare command.
    const { container } = await renderTabWith("https://app.traceroot.ai/api/v1");
    const text = container.textContent ?? "";

    expect(text).toContain("npx -y traceroot-cli@latest setup --project proj_1");
    expect(text).not.toContain("NEXT_PUBLIC_API_URL");
    expect(container.querySelector("pre")).not.toBeNull();
  });

  it("groups GitHub and Slack into the external integrations card", () => {
    render(<AITab projectId="proj_1" />);
    expect(screen.getByText("External integrations")).toBeDefined();
    expect(screen.getByTestId("github-connect")).toBeDefined();
    expect(screen.getByTestId("slack-connect")).toBeDefined();
  });

  it("shows a placeholder instead of the integrations while the project loads", () => {
    // The card reads the workspace id off the project, so rendering it before the
    // fetch settles puts two rows on screen that cannot act on anything.
    projectQuery.isLoading = true;
    projectQuery.data = undefined;
    render(<AITab projectId="proj_1" />);
    expect(screen.getByText("Loading integrations...")).toBeDefined();
    expect(screen.queryByTestId("github-connect")).toBeNull();
  });
});
