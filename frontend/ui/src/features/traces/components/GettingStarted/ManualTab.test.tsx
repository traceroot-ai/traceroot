// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, cleanup, fireEvent, screen, within } from "@testing-library/react";

// The walkthrough is the unit under test; mock the surrounding hooks and
// side-effecting children so the tab renders without a query client or network
// access.
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
vi.mock("./ModelProviderBlock", () => ({
  ModelProviderBlock: ({
    workspaceId,
    providerKey,
  }: {
    workspaceId: string;
    providerKey: unknown;
  }) => (
    <div
      data-testid="model-provider-block"
      data-workspace={workspaceId}
      data-provider-key={JSON.stringify(providerKey)}
    />
  ),
}));
vi.mock("@/components/github/GitHubConnectButton", () => ({
  GitHubConnectButton: () => <div data-testid="github-connect" />,
}));
vi.mock("@/components/slack/SlackConnectButton", () => ({
  SlackConnectButton: () => <div data-testid="slack-connect" />,
}));

import { INTEGRATIONS } from "./integrations";
import { ManualTab } from "./ManualTab";

const byId = (id: string) => INTEGRATIONS.find((integration) => integration.id === id)!;

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
 * Both env vars are stubbed, never left to the machine running the suite.
 * `NEXT_PUBLIC_API_URL` is read through `@/env.client`, which parses it once at
 * module load, so the stub has to be followed by a fresh import of the tab.
 */
async function renderTabWith(env: { apiUrl: string; appUrl: string }) {
  vi.stubEnv("NEXT_PUBLIC_API_URL", env.apiUrl);
  vi.stubEnv("NEXT_PUBLIC_APP_URL", env.appUrl);
  vi.resetModules();
  const { ManualTab: Reloaded } = await import("./ManualTab");
  return render(<Reloaded projectId="proj_1" integration={byId("openai")} />);
}

/** The environment step's code block. */
function envBlock(container: HTMLElement): string {
  const block = Array.from(container.querySelectorAll("pre"))
    .map((pre) => pre.textContent ?? "")
    .find((text) => text.includes("TRACEROOT_API_KEY"));
  if (block === undefined) throw new Error("no environment block rendered");
  return block;
}

describe("ManualTab", () => {
  it("is five steps: the key, the install, the environment, the call, and the connections", () => {
    // The stack picker and the model key are above this section now, shared
    // with the command. What is numbered here is what is actually done in order
    // in a terminal and an editor.
    render(<ManualTab projectId="proj_1" integration={byId("openai")} />);
    const steps = screen
      .getAllByText(/^\d+\. /)
      .map((node) => node.textContent?.replace(/^\d+\. /, ""));
    expect(steps).toEqual([
      "Create an API key",
      "Install SDK",
      "Set environment variables",
      "Initialize TraceRoot for OpenAI",
      "External integrations",
    ]);
  });

  it("does not pick the stack or the model key for itself", () => {
    render(<ManualTab projectId="proj_1" integration={byId("openai")} />);
    expect(screen.queryByText(/Select your stack/)).toBeNull();
    expect(screen.queryByLabelText("Search integrations")).toBeNull();
    expect(screen.queryByText(/Use your own model key/)).toBeNull();
  });

  it("takes its snippets from the stack it is given", () => {
    const { container, rerender } = render(
      <ManualTab projectId="proj_1" integration={byId("openai")} />,
    );
    expect(container.textContent).toContain("pip install traceroot");
    expect(container.textContent).toContain("Integration.OPENAI");

    rerender(<ManualTab projectId="proj_1" integration={byId("mastra")} />);
    expect(screen.getByText(/4\. Initialize TraceRoot for Mastra/)).toBeDefined();
    expect(container.textContent).toContain("@traceroot-ai/mastra");
  });

  it("points the docs link at the stack whose code is on screen", () => {
    // The thing the user said worked: the link follows the selection.
    const { rerender } = render(<ManualTab projectId="proj_1" integration={byId("openai")} />);
    expect(screen.getByRole("link", { name: "View OpenAI docs" }).getAttribute("href")).toBe(
      "https://traceroot.ai/docs/integrations/openai",
    );

    rerender(<ManualTab projectId="proj_1" integration={byId("crewai")} />);
    expect(screen.getByRole("link", { name: "View CrewAI docs" }).getAttribute("href")).toBe(
      "https://traceroot.ai/docs/integrations/crewai",
    );
    expect(screen.queryByRole("link", { name: "View OpenAI docs" })).toBeNull();
  });

  it("offers only the languages the stack has, starting on one it has", () => {
    // Mastra is TypeScript only; Python must not be the resolved tab.
    const { container } = render(<ManualTab projectId="proj_1" integration={byId("mastra")} />);
    const python = screen.getAllByRole("button", { name: "Python" });
    expect(python.every((button) => (button as HTMLButtonElement).disabled)).toBe(true);
    expect(container.textContent).toContain("npm install @traceroot-ai/mastra");
  });

  it("groups GitHub and Slack into the external integrations card", () => {
    render(<ManualTab projectId="proj_1" integration={byId("openai")} />);
    // Number-agnostic: which step this is is already pinned, in order, by the
    // first test in this file. Repeating the ordinal here only made a step
    // being added or removed a two-place edit -- this card went from 6 to 4 in
    // this change alone.
    expect(screen.getByText(/External integrations$/)).toBeDefined();
    expect(screen.getByTestId("github-connect")).toBeDefined();
    expect(screen.getByTestId("slack-connect")).toBeDefined();
  });

  it("says the workspace step is unavailable when the project fetch fails", () => {
    // An errored useProject is not a loading state: isLoading drops with no
    // data behind it. Rendering on `!isLoading` alone gave the step an empty
    // workspace id.
    projectQuery.isLoading = false;
    projectQuery.data = undefined;
    render(<ManualTab projectId="proj_1" integration={byId("openai")} />);
    expect(screen.queryByTestId("github-connect")).toBeNull();
    expect(screen.queryByTestId("slack-connect")).toBeNull();
    expect(screen.getAllByText(/workspace could not be loaded/)).toHaveLength(1);
  });

  it("shows a placeholder instead of the integrations while the project loads", () => {
    // The card reads the workspace id off the project, so rendering it before
    // the fetch settles puts rows on screen that cannot act on anything.
    projectQuery.isLoading = true;
    projectQuery.data = undefined;
    render(<ManualTab projectId="proj_1" integration={byId("openai")} />);
    expect(screen.getByText("Loading integrations...")).toBeDefined();
    expect(screen.queryByTestId("github-connect")).toBeNull();
  });
});

describe("ManualTab with no stack chosen above it", () => {
  // The traces page renders the walkthrough this way: the tab asks for the
  // stack itself, as step 4, and asks for no model key. The model key is asked
  // for during onboarding.
  const stepNames = () =>
    screen.getAllByText(/^\d+\. /).map((node) => node.textContent?.replace(/^\d+\. /, ""));

  it("is six steps, with the stack picker as step 4 and no model key", () => {
    render(<ManualTab projectId="proj_1" />);
    expect(stepNames()).toEqual([
      "Create an API key",
      "Install SDK",
      "Set environment variables",
      "Select your integration",
      "Initialize TraceRoot for OpenAI",
      "External integrations",
    ]);
  });

  it("groups its own picker as providers and frameworks, starting on OpenAI", () => {
    render(<ManualTab projectId="proj_1" />);
    const providers = screen.getByRole("radiogroup", { name: "Model Providers" });
    const frameworks = screen.getByRole("radiogroup", { name: "Frameworks" });
    expect(
      within(providers).getByRole("radio", { name: "OpenAI" }).getAttribute("aria-checked"),
    ).toBe("true");
    // The catalogue's "Frameworks & SDKs" entries land under "Frameworks" here.
    expect(within(frameworks).getByRole("radio", { name: "CrewAI" })).toBeDefined();
    expect(within(frameworks).getByRole("radio", { name: "DSPy" })).toBeDefined();
    expect(within(providers).queryByRole("radio", { name: "CrewAI" })).toBeNull();
    expect(screen.queryByLabelText("Search integrations")).toBeNull();
  });

  it("follows its own picker: the snippets and the docs link under it", () => {
    const { container } = render(<ManualTab projectId="proj_1" />);
    fireEvent.click(screen.getByRole("radio", { name: "Mastra" }));

    expect(screen.getByText("5. Initialize TraceRoot for Mastra")).toBeDefined();
    expect(container.textContent).toContain("@traceroot-ai/mastra");
    const docs = screen.getByRole("link", { name: "View Mastra docs" });
    expect(docs.getAttribute("href")).toBe("https://traceroot.ai/docs/integrations/mastra");
    // Under the picker, ahead of the snippet heading, rather than beside it.
    const frameworks = screen.getByRole("radiogroup", { name: "Frameworks" });
    expect(
      frameworks.compareDocumentPosition(docs) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      docs.compareDocumentPosition(screen.getByText("5. Initialize TraceRoot for Mastra")) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("asks for no model key, on any stack", () => {
    render(<ManualTab projectId="proj_1" />);
    for (const name of ["OpenAI", "Mistral", "CrewAI", "Claude Agent SDK"]) {
      fireEvent.click(screen.getByRole("radio", { name }));
      expect(screen.queryByText(/model key/i)).toBeNull();
      expect(screen.queryByTestId("model-provider-block")).toBeNull();
    }
    expect(screen.getByText("6. External integrations")).toBeDefined();
    expect(screen.getByTestId("github-connect")).toBeDefined();
  });

  it("says the workspace step is unavailable when the project fetch fails", () => {
    projectQuery.isLoading = false;
    projectQuery.data = undefined;
    render(<ManualTab projectId="proj_1" />);
    expect(screen.queryByTestId("model-provider-block")).toBeNull();
    expect(screen.queryByTestId("github-connect")).toBeNull();
    expect(screen.getAllByText(/workspace could not be loaded/)).toHaveLength(1);
    // The picker needs no workspace, so it is still usable.
    expect(screen.getByRole("radiogroup", { name: "Model Providers" })).toBeDefined();
  });

  it("shows a placeholder for the integrations while the project loads", () => {
    projectQuery.isLoading = true;
    projectQuery.data = undefined;
    render(<ManualTab projectId="proj_1" />);
    expect(screen.getByText("Loading integrations...")).toBeDefined();
    expect(screen.queryByText("Loading model providers...")).toBeNull();
    expect(screen.queryByTestId("github-connect")).toBeNull();
  });
});

describe("the environment step", () => {
  // Neither SDK loads a `.env` file, and both default to TraceRoot Cloud when
  // `TRACEROOT_HOST_URL` is unset, so a walkthrough that stops at the key sends
  // a self-hosted reader's key and first traces to Cloud.
  it("sets the host to the origin the setup command uses, on a self-hosted deployment", async () => {
    const { container } = await renderTabWith({
      apiUrl: "http://localhost:8000/api/v1",
      appUrl: "http://localhost:3000",
    });

    expect(envBlock(container)).toBe(
      'export TRACEROOT_API_KEY="your_key_here"\nexport TRACEROOT_HOST_URL="http://localhost:8000"',
    );
    expect(container.textContent).toContain("points the SDK at this deployment");
  });

  it("resolves a same-origin API against the app's origin", async () => {
    const { container } = await renderTabWith({
      apiUrl: "/api/v1",
      appUrl: "https://traceroot.example.com",
    });

    expect(envBlock(container)).toContain(
      'export TRACEROOT_HOST_URL="https://traceroot.example.com"',
    );
  });

  it("leaves the host out on TraceRoot Cloud, which both SDKs default to", async () => {
    const { container } = await renderTabWith({
      apiUrl: "https://app.traceroot.ai/api/v1",
      appUrl: "https://app.traceroot.ai",
    });

    expect(envBlock(container)).toBe('export TRACEROOT_API_KEY="your_key_here"');
    expect(container.textContent).not.toContain("TRACEROOT_HOST_URL");
  });

  it("says the host still has to be set when the API URL is not an origin", async () => {
    // The same case in which the setup command is withheld. No value is
    // guessed, but the reader is not left to find out from a silent export.
    const { container } = await renderTabWith({ apiUrl: "http://:8000", appUrl: "" });
    const text = container.textContent ?? "";

    expect(envBlock(container)).not.toContain("TRACEROOT_HOST_URL");
    expect(text).toContain("NEXT_PUBLIC_API_URL");
    expect(text).toContain("http://:8000");
    // Pointed at the API's origin, never at the value just named as unusable.
    expect(text).toContain("Set TRACEROOT_HOST_URL to the API's origin yourself");
    expect(text).not.toContain("to that address");
    // The variable is inlined at build time, so correcting it alone changes
    // nothing on this page.
    expect(text).toContain("NEXT_PUBLIC_API_URL is corrected and the web app rebuilt");
  });

  it("still sets the host when only the app URL is unusable and the API URL is absolute", async () => {
    // The app URL stops the setup command, whose `--auth-host` it is, but the
    // SDKs need only the API origin, which an absolute API URL names alone.
    const { container } = await renderTabWith({
      apiUrl: "http://localhost:8000/api/v1",
      appUrl: "not-a-url",
    });

    expect(envBlock(container)).toContain('export TRACEROOT_HOST_URL="http://localhost:8000"');
    expect(container.textContent).not.toContain("NEXT_PUBLIC_APP_URL");
  });

  it("says neither SDK loads .env, and shows the load for the language on screen", () => {
    const { container } = render(<ManualTab projectId="proj_1" integration={byId("openai")} />);
    expect(container.textContent).toContain("Neither SDK loads a .env file by itself");
    expect(container.textContent).toContain("from dotenv import load_dotenv; load_dotenv()");

    fireEvent.click(screen.getAllByRole("button", { name: "TypeScript" })[0]);
    expect(container.textContent).toContain(
      "load that before TraceRoot is initialized: config(), from the dotenv package.",
    );
    expect(container.textContent).not.toContain("dotenv/config");
    expect(container.textContent).not.toContain("load_dotenv");
  });
});
