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
  it("renders a done tool step", () => {
    render(<MessageList messages={[makeToolStep("done")]} />);
    expect(screen.getByRole("button")).toBeTruthy();
    expect(screen.getByText("Get weather")).toBeTruthy();
  });

  it("renders an errored tool step", () => {
    render(<MessageList messages={[makeToolStep("error")]} />);
    expect(screen.getByRole("button")).toBeTruthy();
    expect(screen.getByText("Get weather")).toBeTruthy();
  });
});
