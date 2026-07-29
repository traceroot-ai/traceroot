// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, cleanup, screen } from "@testing-library/react";

// Markdown rendering is irrelevant here and pulls in a heavy parser chain.
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

// The waiting indicator carries a label only for a wait the user has no other
// feedback on — a worker writing an answer out-of-band, which can run for tens
// of seconds with nothing else moving on screen. A live stream shows its own
// text arriving, so labelling it would flash between tokens and tool steps.
describe("MessageList waiting indicator", () => {
  it("names what is being waited on when given a label", () => {
    render(
      <MessageList messages={[PROMPT]} sessionStreaming waitingLabel="Analyzing the trace…" />,
    );
    // role=status (via LoadingState) is what makes the wait audible to a screen
    // reader; the bare spinner announces nothing.
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
