// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, cleanup, screen, fireEvent, waitFor } from "@testing-library/react";

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

const { capture } = vi.hoisted(() => ({ capture: vi.fn() }));
vi.mock("posthog-js/react", () => ({ usePostHog: () => ({ capture }) }));

// The account's workspaces; a deployment with a demo workspace lists it for everyone.
const { workspacesQuery } = vi.hoisted(() => ({
  workspacesQuery: { data: [] as { id: string; is_demo?: boolean }[] },
}));
vi.mock("@/features/workspaces/hooks", () => ({ useWorkspaces: () => workspacesQuery }));

import { AITab } from "./AITab";

/** The traces page's wording. */
const PROJECT = {
  projectId: "proj_1",
  surface: "project",
  copy: {
    title: "Run this in your project",
    label: "bash",
    note: "It asks before editing your code. Needs Node.js 20.12 or later.",
  },
} as const;

/** The end of sign-up's wording. */
const ONBOARDING = {
  projectId: "proj_1",
  surface: "onboarding",
  copy: {
    title: "Finish setting up in your terminal",
    intro: "Run it where my-app's code lives.",
    label: "terminal",
  },
} as const;

/** jsdom has no clipboard, so each copy test states what the browser does with the write. */
function stubClipboard(writeText: (text: string) => Promise<void>) {
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
}

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  vi.resetModules();
  projectQuery.data = { workspace_id: "ws_1" };
  projectQuery.isLoading = false;
  workspacesQuery.data = [];
  capture.mockReset();
  Reflect.deleteProperty(navigator, "clipboard");
});

describe("AITab copy tracking", () => {
  it("records the copy once the command is on the clipboard", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    stubClipboard(writeText);
    render(<AITab {...PROJECT} />);

    fireEvent.click(screen.getByRole("button", { name: "Copy bash snippet" }));

    await waitFor(() => expect(capture).toHaveBeenCalledTimes(1));
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining("setup --project proj_1"));
    expect(capture).toHaveBeenCalledWith("setup_command_copied", {
      project_id: "proj_1",
      surface: "project",
    });
  });

  it("records nothing when the browser refuses the copy", async () => {
    stubClipboard(vi.fn().mockRejectedValue(new DOMException("denied", "NotAllowedError")));
    render(<AITab {...PROJECT} />);

    fireEvent.click(screen.getByRole("button", { name: "Copy bash snippet" }));

    // The button's error is shown only after the rejected write was handled, so by
    // then a recorded copy would already have happened.
    expect((await screen.findByRole("alert")).textContent).toContain("Could not copy");
    expect(capture).not.toHaveBeenCalled();
  });
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
  return render(<Reloaded {...PROJECT} />);
}

describe("AITab", () => {
  it("leads with the one command that does the whole setup", () => {
    const { container } = render(<AITab {...PROJECT} />);
    expect(screen.getByText("Run this in your project")).toBeDefined();
    expect(container.textContent ?? "").toContain("npx -y traceroot-cli@0.6.1 setup");
  });

  it("writes the project this panel is showing into the command", () => {
    // The panel knows which project the reader is on; the bare command would
    // ask them, and a multi-project user can answer it wrongly.
    const { container } = render(<AITab {...PROJECT} />);
    expect(container.textContent ?? "").toContain("setup --project proj_1");
  });

  it("does not ask for an API key the command creates itself", () => {
    // The old first step was "1. Create an API key", above a widget that did
    // not create one. `traceroot setup` mints it during the browser handoff, so
    // asking here is work the command exists to do — and two places that both
    // create keys drift the first time either changes.
    const { container } = render(<AITab {...PROJECT} />);
    expect(container.textContent ?? "").not.toContain("Create an API key");
  });

  it("says only what decides whether to paste the command", () => {
    // An account of what setup does competes with the command for the attention
    // of someone who just wants to know what to paste; the docs link has it.
    const { container } = render(<AITab {...PROJECT} />);
    expect(screen.getByText(/asks before editing your code/).textContent).toBe(
      "It asks before editing your code. Needs Node.js 20.12 or later.",
    );
    expect(container.querySelectorAll("li")).toHaveLength(0);
  });

  it("promises neither a coding agent nor a wait for the first trace", () => {
    // Setup asks how to instrument: run an agent, write the task for the
    // reader's own agent, or print the steps. A hand-over changes no code, so
    // setup looks for a trace once and ends; only the agent route waits.
    const { container } = render(<AITab {...PROJECT} />);
    const text = container.textContent ?? "";
    expect(text).not.toContain("coding agent");
    expect(text).not.toContain("waits for the first trace");
  });

  it("keeps the sentence that is consent rather than description", () => {
    // The command edits a repository and can launch an agent. That is the one
    // line that changes whether somebody pastes it. Over uncommitted changes
    // setup asks whether to continue, defaulting to No; it does not stop.
    const { container } = render(<AITab {...PROJECT} />);
    const text = container.textContent ?? "";
    expect(text).toContain("It asks before editing your code.");
    expect(text).not.toContain("stops if you have uncommitted changes");
  });

  it("names the Node version setup needs", () => {
    // `setup` refuses a Node older than 20.12, though the rest of the CLI runs
    // on 20.3, so a working CLI is no sign this command will start.
    const { container } = render(<AITab {...PROJECT} />);
    expect(container.textContent ?? "").toContain("Needs Node.js 20.12 or later.");
  });

  it("gives the reader something to read before they paste it", () => {
    // This section had no link of any kind. It points at the page that
    // documents what the command automates — not the CLI reference, which
    // covers authenticating and reading traces.
    render(<AITab {...PROJECT} />);
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
    // The value is inlined at build time, so a corrected one shows nothing
    // here until the web app is rebuilt, as onboarding's fallback says too.
    expect(text).toContain("Correct that value and rebuild the web app");
    // Says where a working route is, and promises no repair of its own. The
    // manual steps need the API address too, so they are not offered as
    // independent of it.
    expect(text).toContain("manual tab");
    expect(text).toContain("TRACEROOT_HOST_URL");
    expect(text).not.toContain("do not depend on it");
  });

  it("keeps the command for a deployment the CLI's own default already serves", async () => {
    // The contrasting case: no flags because none are needed, which still has
    // to render the bare command.
    const { container } = await renderTabWith("https://app.traceroot.ai/api/v1");
    const text = container.textContent ?? "";

    expect(text).toContain("npx -y traceroot-cli@0.6.1 setup --project proj_1");
    expect(text).not.toContain("NEXT_PUBLIC_API_URL");
    expect(container.querySelector("pre")).not.toBeNull();
  });
});

describe("AITab, after the command", () => {
  it("says what the first trace will show, under the command", () => {
    const { container } = render(<AITab {...PROJECT} />);
    const line = screen.getByText("Open a trace to see every step your agent took.");
    expect(
      container.querySelector("pre")!.compareDocumentPosition(line) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("opens the demo workspace where the deployment has one", () => {
    workspacesQuery.data = [{ id: "ws_1" }, { id: "ws_demo", is_demo: true }];
    render(<AITab {...PROJECT} />);
    expect(screen.getByRole("link", { name: "See the demo project" }).getAttribute("href")).toBe(
      "/workspaces/ws_demo/projects",
    );
  });

  it("offers no demo where the deployment has none", () => {
    workspacesQuery.data = [{ id: "ws_1" }];
    render(<AITab {...PROJECT} />);
    expect(screen.queryByRole("link", { name: "See the demo project" })).toBeNull();
  });

  it("words the command block the way the end of sign-up does", async () => {
    stubClipboard(vi.fn().mockResolvedValue(undefined));
    const { container } = render(
      <AITab {...ONBOARDING} actions={<button type="button">Skip for now</button>} />,
    );

    expect(screen.getByText("Finish setting up in your terminal")).toBeDefined();
    expect(screen.getByText("Run it where my-app's code lives.")).toBeDefined();
    expect(container.textContent).toContain("terminal");
    expect(screen.getByRole("button", { name: "Skip for now" })).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: "Copy terminal snippet" }));
    await waitFor(() =>
      expect(capture).toHaveBeenCalledWith("setup_command_copied", {
        project_id: "proj_1",
        surface: "onboarding",
      }),
    );
  });
});
