// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";

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

const { capture } = vi.hoisted(() => ({ capture: vi.fn() }));
vi.mock("posthog-js/react", () => ({ usePostHog: () => ({ capture }) }));

import { INTEGRATIONS } from "./integrations";
import { ManualTab } from "./ManualTab";

const nameOf = (id: string) => INTEGRATIONS.find((integration) => integration.id === id)!.name;

/** Picks a stack as a person does, opening the folded ones first when it is one of them. */
function chooseStack(name: string) {
  if (!screen.queryByRole("radio", { name })) {
    fireEvent.click(screen.getByRole("button", { name: /^Show \d+ more$/ }));
  }
  fireEvent.click(screen.getByRole("radio", { name }));
}

/** The cards under one of the picker's headings, found from the heading itself. */
const pickerGroup = (label: string) => screen.getByText(label).parentElement!;

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  vi.resetModules();
  capture.mockReset();
  Reflect.deleteProperty(navigator, "clipboard");
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
async function renderTabWith(env: { apiUrl: string; appUrl: string }, integrationId = "openai") {
  vi.stubEnv("NEXT_PUBLIC_API_URL", env.apiUrl);
  vi.stubEnv("NEXT_PUBLIC_APP_URL", env.appUrl);
  vi.resetModules();
  const { ManualTab: Reloaded } = await import("./ManualTab");
  const rendered = render(<Reloaded projectId="proj_1" />);
  chooseStack(nameOf(integrationId));
  return rendered;
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
  // The tab asks for the stack itself, as step 4, and asks for no model key, on
  // the traces page and at the end of sign-up alike.
  const stepNames = () =>
    screen.getAllByText(/^\d+\. /).map((node) => node.textContent?.replace(/^\d+\. /, ""));

  it("is six steps, with the stack picker as step 4 and no model key", () => {
    render(<ManualTab projectId="proj_1" />);
    expect(stepNames()).toEqual([
      "Create an API key",
      "Install SDK",
      "Set environment variables",
      "Select your integration",
      "Initialize traceroot for OpenAI",
      "Run your application",
    ]);
  });

  it("asks for the stack as one named choice, across both headings", () => {
    // One selection, so one radiogroup: a group per heading is announced as two
    // independent choices.
    render(<ManualTab projectId="proj_1" />);
    expect(screen.getAllByRole("radiogroup")).toHaveLength(1);
    const picker = screen.getByRole("radiogroup", { name: "Integration" });
    expect(within(picker).getByText("Model providers")).toBeDefined();
    expect(within(picker).getByText("Frameworks")).toBeDefined();
  });

  it("shows the ten common stacks, in their groups, starting on OpenAI", () => {
    render(<ManualTab projectId="proj_1" />);
    const radios = () =>
      within(screen.getByRole("radiogroup", { name: "Integration" }))
        .getAllByRole("radio")
        .map((radio) => radio.textContent);
    expect(radios()).toEqual([
      "Anthropic",
      "Google Gemini",
      "OpenAI",
      "Claude Agent SDK",
      "CrewAI",
      "LangChain & LangGraph",
      "OpenAI Agents SDK",
      "Vercel AI SDK",
      "Claude Code",
      "Codex",
    ]);
    const providers = pickerGroup("Model providers");
    expect(
      within(providers).getByRole("radio", { name: "OpenAI" }).getAttribute("aria-checked"),
    ).toBe("true");
    // The catalogue's "Frameworks & SDKs" entries land under "Frameworks" here.
    expect(within(pickerGroup("Frameworks")).getByRole("radio", { name: "CrewAI" })).toBeDefined();
    expect(screen.queryByLabelText("Search integrations")).toBeNull();
  });

  it("shows the other thirteen in their own groups, after the common ones, from one control", () => {
    render(<ManualTab projectId="proj_1" />);
    const more = screen.getByRole("button", { name: "Show 13 more" });
    expect(more.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("radio", { name: "DSPy" })).toBeNull();

    fireEvent.click(more);

    const picker = screen.getByRole("radiogroup", { name: "Integration" });
    expect(within(picker).getAllByRole("radio")).toHaveLength(INTEGRATIONS.length);
    const providers = within(pickerGroup("Model providers"))
      .getAllByRole("radio")
      .map((radio) => radio.textContent);
    expect(providers).toEqual(["Anthropic", "Google Gemini", "OpenAI", "Mistral", "OpenRouter"]);
    expect(
      within(pickerGroup("Coding agents")).getByRole("radio", { name: "pi CLI" }),
    ).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: "Show fewer" }));
    expect(screen.queryByRole("radio", { name: "DSPy" })).toBeNull();
  });

  it("keeps a folded stack on screen while it is the one chosen", () => {
    render(<ManualTab projectId="proj_1" />);
    chooseStack("DSPy");
    fireEvent.click(screen.getByRole("button", { name: "Show fewer" }));

    expect(screen.getByRole("radio", { name: "DSPy" }).getAttribute("aria-checked")).toBe("true");
    expect(screen.queryByRole("radio", { name: "AutoGen" })).toBeNull();
  });

  it("says which Python the SDK needs, under the Python install command only", () => {
    render(<ManualTab projectId="proj_1" />);
    const note = screen.getByText("Needs Python 3.11 or later.");
    expect(
      screen.getByText("2. Install SDK").compareDocumentPosition(note) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      note.compareDocumentPosition(screen.getByText("3. Set environment variables")) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();

    fireEvent.click(screen.getAllByRole("button", { name: "TypeScript" })[0]);
    expect(screen.queryByText("Needs Python 3.11 or later.")).toBeNull();
  });

  it("records which snippet was copied, for which stack and surface", async () => {
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
      configurable: true,
    });
    render(<ManualTab projectId="proj_1" surface="onboarding" />);

    fireEvent.click(screen.getByRole("button", { name: "Copy python snippet" }));

    await waitFor(() =>
      expect(capture).toHaveBeenCalledWith("setup_snippet_copied", {
        project_id: "proj_1",
        surface: "onboarding",
        snippet: "sdk_init",
        integration: "openai",
      }),
    );
  });

  it("offers only the languages the stack has, starting on one it has", () => {
    // Mastra is TypeScript only; Python must not be the resolved tab.
    const { container } = render(<ManualTab projectId="proj_1" />);
    chooseStack("Mastra");
    const python = screen.getAllByRole("button", { name: "Python" });
    expect(python.every((button) => (button as HTMLButtonElement).disabled)).toBe(true);
    expect(container.textContent).toContain("npm install @traceroot-ai/mastra");
  });

  it("groups GitHub and Slack into the external integrations card, unnumbered", () => {
    render(<ManualTab projectId="proj_1" />);
    expect(screen.getByText("External integrations")).toBeDefined();
    expect(screen.getByTestId("github-connect")).toBeDefined();
    expect(screen.getByTestId("slack-connect")).toBeDefined();
  });

  it("leaves GitHub and Slack out where the caller hides them", () => {
    // Sign-up does: they move into a sign-up step of their own.
    render(<ManualTab projectId="proj_1" showExternalIntegrations={false} />);
    expect(screen.queryByText("External integrations")).toBeNull();
    expect(screen.queryByTestId("github-connect")).toBeNull();
  });

  it("follows its own picker: the snippets and the docs link under it", () => {
    const { container } = render(<ManualTab projectId="proj_1" />);
    chooseStack("Mastra");

    expect(screen.getByText("5. Initialize traceroot for Mastra")).toBeDefined();
    expect(container.textContent).toContain("@traceroot-ai/mastra");
    const docs = screen.getByRole("link", { name: "View Mastra docs" });
    expect(docs.getAttribute("href")).toBe("https://traceroot.ai/docs/integrations/mastra");
    // Under the picker, ahead of the snippet heading, rather than beside it.
    const picker = screen.getByRole("radiogroup", { name: "Integration" });
    expect(picker.compareDocumentPosition(docs) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(
      docs.compareDocumentPosition(screen.getByText("5. Initialize traceroot for Mastra")) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("asks for no model key, on any stack", () => {
    render(<ManualTab projectId="proj_1" />);
    for (const name of ["OpenAI", "Mistral", "CrewAI", "Claude Agent SDK"]) {
      chooseStack(name);
      expect(screen.queryByText(/model key/i)).toBeNull();
      expect(screen.queryByTestId("model-provider-block")).toBeNull();
    }
    expect(screen.getByText("External integrations")).toBeDefined();
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
    expect(screen.getByRole("radiogroup", { name: "Integration" })).toBeDefined();
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

  it("leaves the host out on traceroot Cloud, which both SDKs default to", async () => {
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

  it("points coding-agent plugins at this deployment", async () => {
    const env = { apiUrl: "http://localhost:8000/api/v1", appUrl: "http://localhost:3000" };
    const codex = await renderTabWith(env, "codex");
    expect(codex.container.textContent).toContain('"host_url": "http://localhost:8000"');
    cleanup();

    const claude = await renderTabWith(env, "claude-code");
    expect(claude.container.textContent).toContain(
      'traceroot-observability@traceroot-claude-code-plugin --config TRACEROOT_HOST_URL="http://localhost:8000"',
    );
    expect(claude.container.textContent).not.toContain("export TRACEROOT_HOST_URL");
  });

  it("says the host still has to be set for a plugin when the API URL is not an origin", async () => {
    const { container } = await renderTabWith({ apiUrl: "http://:8000", appUrl: "" }, "codex");
    expect(container.textContent).toContain("Set TRACEROOT_HOST_URL to the API's origin yourself");
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
    const { container } = render(<ManualTab projectId="proj_1" />);
    expect(container.textContent).toContain("Neither SDK loads a .env file by itself");
    expect(container.textContent).toContain("from dotenv import load_dotenv; load_dotenv()");

    fireEvent.click(screen.getAllByRole("button", { name: "TypeScript" })[0]);
    expect(container.textContent).toContain(
      "load that before traceroot is initialized: config(), from the dotenv package.",
    );
    expect(container.textContent).not.toContain("dotenv/config");
    expect(container.textContent).not.toContain("load_dotenv");
  });
});
