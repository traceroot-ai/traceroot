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
    stackName,
  }: {
    workspaceId: string;
    providerKey: unknown;
    stackName: string;
  }) => (
    <div
      data-testid="model-provider-block"
      data-workspace={workspaceId}
      data-provider-key={JSON.stringify(providerKey)}
      data-stack={stackName}
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
  projectQuery.data = { workspace_id: "ws_1" };
  projectQuery.isLoading = false;
});

describe("ManualTab", () => {
  it("is four steps: the key, the install, the call, and the connections", () => {
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
    expect(screen.getByText(/3\. Initialize TraceRoot for Mastra/)).toBeDefined();
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
  // Rendered on its own, with no picker above it, the tab has to ask for the
  // stack and the model key itself — as the six steps it was before the panel
  // lifted both out. Onboarding's manual step rendered it this way until it
  // took the panel's shared picker.
  const stepNames = () =>
    screen.getAllByText(/^\d+\. /).map((node) => node.textContent?.replace(/^\d+\. /, ""));

  it("is six steps, with the stack picker and the model key back in them", () => {
    render(<ManualTab projectId="proj_1" />);
    expect(stepNames()).toEqual([
      "Create an API key",
      "Install SDK",
      "Select your integration",
      "Initialize TraceRoot for OpenAI",
      "Use your own model key",
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
    // The panel's "Frameworks & SDKs" entries land under "Frameworks" here.
    expect(within(frameworks).getByRole("radio", { name: "CrewAI" })).toBeDefined();
    expect(within(frameworks).getByRole("radio", { name: "DSPy" })).toBeDefined();
    expect(within(providers).queryByRole("radio", { name: "CrewAI" })).toBeNull();
    expect(screen.queryByLabelText("Search integrations")).toBeNull();
  });

  it("follows its own picker: the snippets, the docs link and the key it asks for", () => {
    const { container } = render(<ManualTab projectId="proj_1" />);
    fireEvent.click(screen.getByRole("radio", { name: "Mastra" }));

    expect(screen.getByText("4. Initialize TraceRoot for Mastra")).toBeDefined();
    expect(container.textContent).toContain("@traceroot-ai/mastra");
    expect(screen.getByRole("link", { name: "View Mastra docs" }).getAttribute("href")).toBe(
      "https://traceroot.ai/docs/integrations/mastra",
    );
    const block = screen.getByTestId("model-provider-block");
    expect(block.dataset.stack).toBe("Mastra");
    expect(block.dataset.providerKey).toBe(JSON.stringify(byId("mastra").providerKey));
  });

  it("offers the model key step after the four that produce a trace", () => {
    render(<ManualTab projectId="proj_1" />);
    expect(screen.getByText("5. Use your own model key")).toBeDefined();
    expect(screen.getByTestId("model-provider-block").dataset.workspace).toBe("ws_1");
    expect(screen.getByText("6. External integrations")).toBeDefined();
    expect(screen.getByTestId("github-connect")).toBeDefined();
  });

  it("says both workspace steps are unavailable when the project fetch fails", () => {
    projectQuery.isLoading = false;
    projectQuery.data = undefined;
    render(<ManualTab projectId="proj_1" />);
    expect(screen.queryByTestId("model-provider-block")).toBeNull();
    expect(screen.queryByTestId("github-connect")).toBeNull();
    expect(screen.getAllByText(/workspace could not be loaded/)).toHaveLength(2);
  });

  it("shows a placeholder for both workspace steps while the project loads", () => {
    projectQuery.isLoading = true;
    projectQuery.data = undefined;
    render(<ManualTab projectId="proj_1" />);
    expect(screen.getByText("Loading model providers...")).toBeDefined();
    expect(screen.getByText("Loading integrations...")).toBeDefined();
    expect(screen.queryByTestId("model-provider-block")).toBeNull();
  });
});
