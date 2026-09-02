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

/** A text segment flushed at a tool boundary: no trace stamp, no usage. */
const segment = (id: string): AIMessage =>
  ({ id, role: "assistant", content: "thinking out loud" }) as AIMessage;

/** The run's final bubble, with usage so the footer (and its "View trace") renders. */
const finalBubble = (id: string, trace?: { traceId: string; traceStatus: string }): AIMessage =>
  ({
    id,
    role: "assistant",
    content: "answer",
    inputTokens: 12,
    outputTokens: 34,
    ...trace,
  }) as unknown as AIMessage;

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

  it("links every step of a text → tool → text turn, not just the one before the final bubble", () => {
    // The trace is stamped on the run's last segment only; the segment right
    // after t1 carries none, and t1 used to lose its link because of it.
    const onOpenTrace = vi.fn();
    render(
      <MessageList
        messages={[user("u1"), step("t1"), segment("a1"), step("t2"), assistant("a2", "trace-1")]}
        onOpenTrace={onOpenTrace}
      />,
    );
    openSteps();
    const links = screen.getAllByText("Open span");
    expect(links).toHaveLength(2);
    fireEvent.click(links[0]);
    expect(onOpenTrace).toHaveBeenCalledWith("trace-1", "span-t1");
    fireEvent.click(links[1]);
    expect(onOpenTrace).toHaveBeenCalledWith("trace-1", "span-t2");
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

describe("MessageList per-turn View trace", () => {
  it("renders View trace in the usage footer once the turn's trace is available, and opens it", () => {
    const onOpenTrace = vi.fn();
    render(
      <MessageList
        messages={[user("u1"), finalBubble("a1", { traceId: "trace-1", traceStatus: "available" })]}
        onOpenTrace={onOpenTrace}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "View trace" }));
    expect(onOpenTrace).toHaveBeenCalledTimes(1);
    expect(onOpenTrace).toHaveBeenCalledWith("trace-1");
  });

  it("renders no View trace while the export is pending, or without a handler", () => {
    render(
      <MessageList
        messages={[user("u1"), finalBubble("a1", { traceId: "trace-1", traceStatus: "pending" })]}
        onOpenTrace={vi.fn()}
      />,
    );
    // The footer itself is there (usage), only the link is withheld.
    expect(screen.getByText("12 in")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "View trace" })).toBeNull();
    cleanup();

    render(
      <MessageList
        messages={[user("u1"), finalBubble("a1", { traceId: "trace-1", traceStatus: "available" })]}
      />,
    );
    expect(screen.queryByRole("button", { name: "View trace" })).toBeNull();
  });
});
