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
// The two buttons stand in, but they carry the one sentence the real ones show
// when they are handed a workspace id their queries refuse: an empty id
// disables them, so no role comes back, `canManage` is false, and both offer an
// admin to ask in place of a Connect button — see
// `components/github/GitHubConnectButton.tsx` and
// `components/slack/SlackConnectButton.tsx`. That sentence is the harm the
// guard on this tab exists to prevent, so the tests have to be able to see it.
vi.mock("@/components/github/GitHubConnectButton", () => ({
  GitHubConnectButton: ({ workspaceId }: { workspaceId: string }) => (
    <div data-testid="github-connect">
      {workspaceId ? null : "GitHub is not connected. Ask a workspace admin to set it up."}
    </div>
  ),
}));
vi.mock("@/components/slack/SlackConnectButton", () => ({
  SlackConnectButton: ({ workspaceId }: { workspaceId: string }) => (
    <div data-testid="slack-connect">
      {workspaceId ? null : "Slack is not connected. Ask a workspace admin to set it up."}
    </div>
  ),
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
    expect(container.textContent ?? "").toContain("npx -y traceroot-cli@0.6.0 setup");
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

  it("describes the command in a few sentences, not a list of stages", () => {
    // A bulleted account of every stage competes with the command for the
    // attention of someone who just wants to know what to paste.
    const { container } = render(<AITab projectId="proj_1" />);
    const text = container.textContent ?? "";
    expect(text).toContain("Writes the API key into your repository");
    expect(text).toContain("waits for the first trace");
    expect(container.querySelectorAll("li")).toHaveLength(0);
  });

  it("does not say a coding agent always does the work", () => {
    // Setup asks how to instrument: run an agent, write the task for the
    // reader's own agent, or print the steps. Unattended, it writes the task.
    const { container } = render(<AITab projectId="proj_1" />);
    const text = container.textContent ?? "";
    expect(text).toContain(
      "instruments it with a coding agent or hands you the task to run yourself",
    );
    expect(text).not.toContain("Instruments your repository with a coding agent");
  });

  it("keeps the sentence that is consent rather than description", () => {
    // The command edits a repository and can launch an agent. That is the one
    // line that changes whether somebody pastes it. Over uncommitted changes
    // setup asks whether to continue, defaulting to No; it does not stop.
    const { container } = render(<AITab projectId="proj_1" />);
    const text = container.textContent ?? "";
    expect(text).toContain("Asks before editing");
    expect(text).toContain("asks before continuing over uncommitted changes");
    expect(text).not.toContain("stops if you have uncommitted changes");
  });

  it("names the Node version setup needs", () => {
    // `setup` refuses a Node older than 20.12, though the rest of the CLI runs
    // on 20.3, so a working CLI is no sign this command will start.
    const { container } = render(<AITab projectId="proj_1" />);
    expect(container.textContent ?? "").toContain("Needs Node.js 20.12 or later.");
  });

  it("gives the reader something to read before they paste it", () => {
    // This section had no link of any kind. It points at the page that
    // documents what the command automates — not the CLI reference, which
    // covers authenticating and reading traces.
    render(<AITab projectId="proj_1" />);
    const docs = screen.getByRole("link", { name: "View the tracing docs" });
    expect(docs.getAttribute("href")).toBe("https://traceroot.ai/docs/tracing/get-started");
    expect(docs.getAttribute("target")).toBe("_blank");
    expect(docs.getAttribute("rel")).toContain("noopener");
  });

  it("shows no runnable command when the deployment's API URL is not an origin", async () => {
    // `NEXT_PUBLIC_API_URL` is `z.string()` with no URL validation, so a value
    // like this reaches the panel. The command rendered for it used to be the
    // unflagged one, which targets TraceRoot Cloud — so a self-hosted reader
    // was handed a confident line that signs in against the wrong deployment.
    const { container } = await renderTabWith("http://:8000");
    const text = container.textContent ?? "";

    expect(text).not.toContain("npx -y traceroot-cli@");
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

    expect(text).toContain("npx -y traceroot-cli@0.6.0 setup --project proj_1");
    expect(text).not.toContain("NEXT_PUBLIC_API_URL");
    expect(container.querySelector("pre")).not.toBeNull();
  });

  it("groups GitHub and Slack into the external integrations card", () => {
    render(<AITab projectId="proj_1" />);
    expect(screen.getByText("External integrations")).toBeDefined();
    expect(screen.getByTestId("github-connect")).toBeDefined();
    expect(screen.getByTestId("slack-connect")).toBeDefined();
  });

  it("says the workspace step is unavailable when the project fetch fails", () => {
    // An errored useProject is not a loading state: isLoading drops with no
    // data behind it. Rendering on `!isLoading` alone gave the card an empty
    // workspace id — and this is the tab the panel opens on, so the first
    // thing a customer who has just created a workspace and is its admin was
    // told is to go and ask an admin, with no Connect button to use instead.
    projectQuery.isLoading = false;
    projectQuery.data = undefined;
    const { container } = render(<AITab projectId="proj_1" />);
    expect(screen.queryByTestId("github-connect")).toBeNull();
    expect(screen.queryByTestId("slack-connect")).toBeNull();
    expect(screen.getAllByText(/workspace could not be loaded/)).toHaveLength(1);
    expect(container.textContent ?? "").not.toContain("Ask a workspace admin");
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
