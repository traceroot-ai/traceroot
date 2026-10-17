// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

// The step embeds the traces panel's own setup, whose connected pieces — the
// one-time key, the two external-service rows, the provider key form — each
// fetch. Stubbed exactly as that panel's own tests stub them: what this file is
// about is which of those pieces onboarding gets, and in what order.
const { projectQuery } = vi.hoisted(() => ({
  projectQuery: { data: { workspace_id: "ws-1" }, isLoading: false } as {
    data?: { workspace_id: string };
    isLoading: boolean;
  },
}));
vi.mock("@/features/projects/hooks", () => ({
  useProject: () => projectQuery,
}));
vi.mock("@/features/traces/components/GettingStarted/ApiKeyBlock", () => ({
  ApiKeyBlock: () => <div data-testid="api-key-block" />,
}));
vi.mock("@/components/github/GitHubConnectButton", () => ({
  GitHubConnectButton: () => <div data-testid="github-connect" />,
}));
vi.mock("@/components/slack/SlackConnectButton", () => ({
  SlackConnectButton: () => <div data-testid="slack-connect" />,
}));
// Stands in for the key form so the binding it is handed can be read off the
// DOM — the same stand-in the traces panel's own suite uses, because what has
// to hold here is that onboarding drives it from the same selection. The copy
// it renders from a binding is covered in ModelProviderBlock.test.tsx.
vi.mock("@/features/traces/components/GettingStarted/ModelProviderBlock", () => ({
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
      data-stack={stackName}
    />
  ),
}));
vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));

import type { TraceWait } from "@/lib/hooks/use-trace-wait";
import { ManualSetupStep } from "./manual-setup-step";

function renderStep(wait: TraceWait = { kind: "waiting" }) {
  const onBack = vi.fn();
  const onDone = vi.fn();
  const { container } = render(
    <ManualSetupStep projectId="proj-1" onBack={onBack} onDone={onDone} wait={wait} />,
  );
  return { container, onBack, onDone };
}

const keyBlock = () => screen.getByTestId("model-provider-block");
const pickStack = (name: string) => fireEvent.click(screen.getByRole("radio", { name }));

/** Document order, so "above" is asserted rather than read off the markup. */
function isAbove(first: Element, second: Element): boolean {
  return Boolean(first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING);
}

afterEach(() => {
  cleanup();
  projectQuery.data = { workspace_id: "ws-1" };
  projectQuery.isLoading = false;
});

describe("what onboarding's manual step asks for", () => {
  it("asks which stack and whose model key, not just how to instrument", () => {
    // The walkthrough on its own would show this account OpenAI's snippet with
    // no way to say they are not using OpenAI, and no key field at all. Both
    // questions moved above the walkthrough when the traces panel was
    // restructured; this step shows the same two.
    renderStep();

    expect(screen.getByRole("radiogroup", { name: "Stack" })).toBeDefined();
    expect(screen.getByLabelText("Search integrations")).toBeDefined();
    expect(screen.getByText("Use your own model key")).toBeDefined();
    expect(keyBlock().dataset.workspace).toBe("ws-1");
  });

  it("renders the walkthrough itself rather than a second copy of it", () => {
    // Matched without the step numbers: inserting a step into the walkthrough
    // renumbers the ones below it, and that is not this step's business.
    renderStep();

    expect(screen.getByText(/Create an API key/)).toBeDefined();
    expect(screen.getByTestId("api-key-block")).toBeDefined();
    expect(screen.getByText(/Initialize TraceRoot for OpenAI/)).toBeDefined();
    expect(screen.getByText(/External integrations/)).toBeDefined();
  });

  it("drives the snippet and the key off the picker, as the traces panel does", () => {
    const { container } = renderStep();
    expect(container.textContent).toContain("Integration.OPENAI");
    expect(keyBlock().dataset.stack).toBe("OpenAI");
    expect(keyBlock().dataset.adapter).toBe("openai");

    pickStack("Anthropic");
    expect(screen.getByText(/Initialize TraceRoot for Anthropic/)).toBeDefined();
    expect(container.textContent).toContain("Integration.ANTHROPIC");
    expect(keyBlock().dataset.kind).toBe("fixed");
    expect(keyBlock().dataset.adapter).toBe("anthropic");
    expect(keyBlock().dataset.stack).toBe("Anthropic");

    // A framework that takes any provider: the key field is told so, and told
    // which one the snippet on screen happens to call.
    pickStack("CrewAI");
    expect(screen.getByText(/Initialize TraceRoot for CrewAI/)).toBeDefined();
    expect(keyBlock().dataset.kind).toBe("suggested");
    expect(keyBlock().dataset.adapter).toBe("openai");
    expect(keyBlock().dataset.stack).toBe("CrewAI");
  });

  it("holds the selection when a search hides the selected card", () => {
    renderStep();
    pickStack("CrewAI");
    fireEvent.change(screen.getByLabelText("Search integrations"), { target: { value: "dspy" } });

    expect(screen.queryByRole("radio", { name: "CrewAI" })).toBeNull();
    expect(keyBlock().dataset.stack).toBe("CrewAI");
    expect(screen.getByText(/Initialize TraceRoot for CrewAI/)).toBeDefined();
  });

  it("still ends on the two ways out of the step", () => {
    const { onBack, onDone } = renderStep();

    fireEvent.click(screen.getByRole("button", { name: "Go to my project" }));
    expect(onDone).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Back to the terminal command" }));
    expect(onBack).toHaveBeenCalledTimes(1);
  });
});

describe("where the first-trace line sits on the manual step", () => {
  it("sits under the stack picker and above the key field", () => {
    // The user's own ask, after watching a competitor: the waiting line goes up,
    // not at the bottom. At the bottom it sat under the key field, both
    // snippets and the integrations card — unreadable without scrolling past
    // the whole walkthrough, which is exactly what someone who is watching
    // their terminal will not do.
    renderStep();
    const line = screen.getByText(/Waiting for your first trace/);

    expect(isAbove(screen.getByText("Select your stack"), line)).toBe(true);
    expect(isAbove(line, screen.getByText("Use your own model key"))).toBe(true);
    expect(isAbove(line, screen.getByText(/Create an API key/))).toBe(true);
  });

  it("reports the arrived trace in that same place, with the link to it", () => {
    // The page opens the trace; this line only reports it, and keeps the link
    // as the way through until that push lands.
    renderStep({ kind: "found", found: { projectId: "proj-1", traceId: "t-1" } });
    const line = screen.getByText(/Your first trace arrived/);

    expect(isAbove(screen.getByText("Select your stack"), line)).toBe(true);
    expect(isAbove(line, screen.getByText("Use your own model key"))).toBe(true);
    expect(screen.getByRole("link", { name: "View it" }).getAttribute("href")).toBe(
      "/projects/proj-1/traces?traceId=t-1",
    );
    // Nothing about the arrival closes the step down.
    expect(screen.getByRole("button", { name: "Go to my project" })).toBeDefined();
    expect(screen.getByRole("radiogroup", { name: "Stack" })).toBeDefined();
  });

  it("says so in that same place when no trace turns up", () => {
    renderStep({ kind: "gave-up", fallbackUrl: "/projects/proj-1/traces" });
    const line = screen.getByText(/Still no trace/);

    expect(isAbove(screen.getByText("Select your stack"), line)).toBe(true);
    expect(isAbove(line, screen.getByText("Use your own model key"))).toBe(true);
    expect(screen.getByRole("link", { name: "Open your traces" }).getAttribute("href")).toBe(
      "/projects/proj-1/traces",
    );
  });
});

describe("a workspace that cannot be read", () => {
  it("says so rather than handing the key field an empty workspace id", () => {
    projectQuery.isLoading = false;
    projectQuery.data = undefined;
    renderStep();

    expect(screen.queryByTestId("model-provider-block")).toBeNull();
    expect(screen.getAllByText(/workspace could not be loaded/).length).toBeGreaterThan(0);
    // The picker needs no workspace, and neither does the watch.
    expect(screen.getByRole("radiogroup", { name: "Stack" })).toBeDefined();
    expect(screen.getByText(/Waiting for your first trace/)).toBeDefined();
  });

  it("shows a placeholder for the key field while the project loads", () => {
    projectQuery.isLoading = true;
    projectQuery.data = undefined;
    renderStep();

    expect(screen.getByText("Loading model providers...")).toBeDefined();
    expect(screen.queryByTestId("model-provider-block")).toBeNull();
  });
});
