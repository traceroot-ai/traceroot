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
// Stands in for the key form so the binding it is handed can be read off the
// DOM; the form's own behaviour is covered in ModelProviderBlock.test.tsx.
vi.mock("./ModelProviderBlock", () => ({
  ModelProviderBlock: ({
    workspaceId,
    providerKey,
    stackName,
  }: {
    workspaceId: string;
    providerKey: { kind: string; adapter?: string; provider?: string };
    stackName: string;
  }) => (
    <div
      data-testid="model-provider-block"
      data-workspace={workspaceId}
      data-kind={providerKey.kind}
      data-adapter={providerKey.adapter ?? ""}
      data-provider={providerKey.provider ?? ""}
      data-stack={stackName}
    />
  ),
}));

import { GettingStarted } from "./index";

afterEach(() => {
  cleanup();
  projectQuery.data = { workspace_id: "ws_1" };
  projectQuery.isLoading = false;
});

const keyBlock = () => screen.getByTestId("model-provider-block");
const pickStack = (name: string) => fireEvent.click(screen.getByRole("radio", { name }));
const pickMode = (name: string) => fireEvent.click(screen.getByRole("button", { name }));

describe("the order the panel asks its questions in", () => {
  it("asks for the stack, then the key, then how to instrument", () => {
    const { container } = render(<GettingStarted projectId="proj_1" />);
    const text = container.textContent ?? "";
    expect(text.indexOf("Select your stack")).toBeGreaterThan(-1);
    expect(text.indexOf("Select your stack")).toBeLessThan(text.indexOf("Use your own model key"));
    expect(text.indexOf("Use your own model key")).toBeLessThan(text.indexOf("Using AI"));
    expect(text.indexOf("Using AI")).toBeLessThan(text.indexOf("Run this in your project"));
  });

  it("does not promise a command, now that the command is one section of two", () => {
    const { container } = render(<GettingStarted projectId="proj_1" />);
    expect(container.textContent).not.toContain("with the command below");
  });
});

describe("switching between the command and the manual steps", () => {
  it("replaces the section under the switch and nothing above it", () => {
    render(<GettingStarted projectId="proj_1" />);
    expect(screen.getByText("Run this in your project")).toBeTruthy();
    expect(screen.queryByText("2. Install SDK")).toBeNull();

    pickMode("Manual");
    expect(screen.getByText("2. Install SDK")).toBeTruthy();
    expect(screen.queryByText("Run this in your project")).toBeNull();

    // And the shared top is still there, on both sides of the switch.
    expect(screen.getByText("Select your stack")).toBeTruthy();
    expect(screen.getByText("Use your own model key")).toBeTruthy();
  });

  it("holds the top in place rather than re-rendering it", () => {
    // The user's own observation: the top must not change or change position.
    // Same DOM nodes before and after is the strongest form of that — a
    // remount would replace them even if the markup came out identical.
    render(<GettingStarted projectId="proj_1" />);
    const heading = screen.getByRole("heading", { name: "Get started with tracing" });
    const picker = screen.getByRole("radiogroup", { name: "Stack" });
    const searchBox = screen.getByLabelText("Search integrations");
    const field = keyBlock();

    pickMode("Manual");
    expect(screen.getByRole("heading", { name: "Get started with tracing" })).toBe(heading);
    expect(screen.getByRole("radiogroup", { name: "Stack" })).toBe(picker);
    expect(screen.getByLabelText("Search integrations")).toBe(searchBox);
    expect(screen.getByTestId("model-provider-block")).toBe(field);

    pickMode("Using AI");
    expect(screen.getByLabelText("Search integrations")).toBe(searchBox);
    expect(screen.getByTestId("model-provider-block")).toBe(field);
  });

  it("keeps what has been typed and chosen above it", () => {
    render(<GettingStarted projectId="proj_1" />);
    fireEvent.change(screen.getByLabelText("Search integrations"), { target: { value: "crew" } });
    pickStack("CrewAI");

    pickMode("Manual");
    expect((screen.getByLabelText("Search integrations") as HTMLInputElement).value).toBe("crew");
    expect(screen.getByText("3. Initialize TraceRoot for CrewAI")).toBeTruthy();
    expect(keyBlock().dataset.stack).toBe("CrewAI");
  });
});

describe("the key the panel asks for", () => {
  it("starts on the selected stack's own provider", () => {
    render(<GettingStarted projectId="proj_1" />);
    expect(keyBlock().dataset.stack).toBe("OpenAI");
    expect(keyBlock().dataset.kind).toBe("fixed");
    expect(keyBlock().dataset.adapter).toBe("openai");
  });

  it("follows the selection across all three groups", () => {
    render(<GettingStarted projectId="proj_1" />);

    // A model provider: its own key, with nothing to switch.
    pickStack("Mistral");
    expect(keyBlock().dataset.kind).toBe("none");
    expect(keyBlock().dataset.provider).toBe("Mistral");

    // An SDK integration whose example calls OpenAI.
    pickStack("Vercel AI SDK");
    expect(keyBlock().dataset.kind).toBe("suggested");
    expect(keyBlock().dataset.adapter).toBe("openai");

    // An agent framework whose example calls Anthropic.
    pickStack("Claude Agent SDK");
    expect(keyBlock().dataset.kind).toBe("fixed");
    expect(keyBlock().dataset.adapter).toBe("anthropic");
    expect(keyBlock().dataset.stack).toBe("Claude Agent SDK");
  });

  it("asks for it on the command route as well as the manual one", () => {
    // Which provider's key the assistant and detectors should run on is not a
    // manual-setup question, so it is not inside the manual section.
    render(<GettingStarted projectId="proj_1" />);
    expect(keyBlock()).toBeTruthy();
    pickMode("Manual");
    expect(keyBlock()).toBeTruthy();
  });

  it("holds the selection when a search hides the selected card", () => {
    render(<GettingStarted projectId="proj_1" />);
    pickStack("CrewAI");
    fireEvent.change(screen.getByLabelText("Search integrations"), { target: { value: "dspy" } });
    expect(screen.queryByRole("radio", { name: "CrewAI" })).toBeNull();
    expect(keyBlock().dataset.stack).toBe("CrewAI");
  });
});

describe("a workspace that cannot be read", () => {
  it("shows a placeholder for the key field while the project loads", () => {
    projectQuery.isLoading = true;
    projectQuery.data = undefined;
    render(<GettingStarted projectId="proj_1" />);
    expect(screen.getByText("Loading model providers...")).toBeTruthy();
    expect(screen.queryByTestId("model-provider-block")).toBeNull();
  });

  it("says so rather than handing the key field an empty workspace id", () => {
    projectQuery.isLoading = false;
    projectQuery.data = undefined;
    render(<GettingStarted projectId="proj_1" />);
    expect(screen.queryByTestId("model-provider-block")).toBeNull();
    expect(screen.getByText(/workspace could not be loaded/)).toBeTruthy();
    // The stack picker needs no workspace, so it is still usable.
    expect(screen.getByRole("radiogroup", { name: "Stack" })).toBeTruthy();
  });
});
