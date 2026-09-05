// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { AIMessage } from "../types";

beforeAll(() => {
  // jsdom does not implement ResizeObserver
  global.ResizeObserver = class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

vi.mock("react-markdown", () => ({
  default: ({ children }: { children: string }) => <>{children}</>,
}));
vi.mock("remark-gfm", () => ({ default: () => {} }));
vi.mock("@/components/icons/domain-icons", () => ({
  DOMAIN_ICONS: {
    success: (props: React.SVGProps<SVGSVGElement>) => (
      <svg data-testid="icon-success" {...props} />
    ),
    failure: (props: React.SVGProps<SVGSVGElement>) => (
      <svg data-testid="icon-failure" {...props} />
    ),
    pending: (props: React.SVGProps<SVGSVGElement>) => (
      <svg data-testid="icon-pending" {...props} />
    ),
  },
}));

import { MessageList } from "./message-list";

afterEach(() => cleanup());

function makeToolStep(status: "done" | "error" | "running"): AIMessage {
  return {
    id: "step-1",
    role: "tool_step",
    content: "",
    timestamp: "2026-01-01T00:00:00.000Z",
    toolStep: {
      toolCallId: "tc-1",
      toolName: "get_weather",
      args: { city: "London" },
      status,
    },
  };
}

describe("MessageList — ToolStepItem status icons", () => {
  it("shows the success icon for a done step, not the failure icon", () => {
    render(<MessageList messages={[makeToolStep("done")]} />);
    expect(screen.getByTestId("icon-success")).toBeTruthy();
    expect(screen.queryByTestId("icon-failure")).toBeNull();
  });

  it("shows the failure icon for an errored step, not the success icon", () => {
    render(<MessageList messages={[makeToolStep("error")]} />);
    expect(screen.getByTestId("icon-failure")).toBeTruthy();
    expect(screen.queryByTestId("icon-success")).toBeNull();
  });

  it("shows neither success nor failure icon for a running step", () => {
    render(<MessageList messages={[makeToolStep("running")]} />);
    expect(screen.queryByTestId("icon-success")).toBeNull();
    expect(screen.queryByTestId("icon-failure")).toBeNull();
  });
});
