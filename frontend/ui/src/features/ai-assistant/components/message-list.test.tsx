// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, cleanup, screen } from "@testing-library/react";

// Stub out the markdown parser; rendering it isn't what's under test.
vi.mock("react-markdown", () => ({
  default: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock("remark-gfm", () => ({ default: () => {} }));

import { MessageList } from "./message-list";
import type { AIMessage } from "../types";

const PROMPT: AIMessage = {
  id: "u-1",
  role: "user",
  content: "Analyze this trace",
  timestamp: "2026-01-01T00:00:00Z",
};

afterEach(cleanup);

// The label is for waits with no other feedback on screen. A live stream shows
// its own text arriving, so labelling it would flash between tokens.
describe("MessageList waiting indicator", () => {
  it("names what is being waited on when given a label", () => {
    render(
      <MessageList messages={[PROMPT]} sessionStreaming waitingLabel="Analyzing the trace…" />,
    );
    // LoadingState's role=status is what a screen reader announces; the bare
    // spinner announces nothing.
    expect(screen.getByRole("status").textContent).toContain("Analyzing the trace…");
  });

  it("stays unlabelled for a live stream", () => {
    render(<MessageList messages={[PROMPT]} sessionStreaming />);
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("shows no indicator at all once the session is idle", () => {
    render(<MessageList messages={[PROMPT]} waitingLabel="Analyzing the trace…" />);
    expect(screen.queryByRole("status")).toBeNull();
  });
});
