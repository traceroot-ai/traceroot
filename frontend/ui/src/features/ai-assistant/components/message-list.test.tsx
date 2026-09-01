// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

vi.mock("react-markdown", () => ({
  default: ({ children }: { children: string }) => <>{children}</>,
}));
vi.mock("remark-gfm", () => ({ default: () => {} }));

import { MessageList } from "./message-list";
import type { AIMessage } from "../types";

afterEach(cleanup);

const step = (id: string): AIMessage =>
  ({
    id,
    role: "tool_step",
    content: "",
    toolStep: { toolCallId: id, toolName: "read", args: {}, spanId: `span-${id}`, isError: false },
  }) as unknown as AIMessage;

const user = (id: string): AIMessage => ({ id, role: "user", content: "ask" }) as AIMessage;

const assistant = (id: string, traceId: string, traceStatus = "available"): AIMessage =>
  ({ id, role: "assistant", content: "answer", traceId, traceStatus }) as unknown as AIMessage;

/** Expand every tool step so its "Open span" control is in the DOM. */
function openSteps() {
  // The step header is a button carrying the raw tool name in parentheses.
  for (const b of screen.getAllByRole("button")) {
    if (b.textContent?.includes("(read)")) fireEvent.click(b);
  }
}

describe("MessageList tool-step trace resolution", () => {
  it("links a tool step to its own turn's trace", () => {
    const onOpenTrace = vi.fn();
    render(
      <MessageList
        messages={[user("u1"), step("t1"), assistant("a1", "trace-1")]}
        onOpenTrace={onOpenTrace}
      />,
    );
    openSteps();
    fireEvent.click(screen.getByText("Open span"));
    expect(onOpenTrace).toHaveBeenCalledWith("trace-1", "span-t1");
  });

  it("does not reach past a turn boundary for a trace", () => {
    // A tool-only run produces no assistant bubble. Scanning past the next user
    // message would attach this step to the following turn's trace — a
    // different trace, which does not contain this span.
    const onOpenTrace = vi.fn();
    render(
      <MessageList
        messages={[user("u1"), step("t1"), user("u2"), assistant("a2", "trace-2")]}
        onOpenTrace={onOpenTrace}
      />,
    );
    openSteps();
    expect(screen.queryByText("Open span")).toBeNull();
  });

  it("offers no link while the turn's trace is pending or failed", () => {
    for (const status of ["pending", "failed", "disabled"]) {
      const onOpenTrace = vi.fn();
      render(
        <MessageList
          messages={[user("u1"), step("t1"), assistant("a1", "trace-1", status)]}
          onOpenTrace={onOpenTrace}
        />,
      );
      openSteps();
      expect(screen.queryByText("Open span")).toBeNull();
      cleanup();
    }
  });
});
