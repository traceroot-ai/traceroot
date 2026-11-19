// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { SpanStatus } from "@traceroot/core";
import type { Span, SpanIO, TraceDetail } from "@/types/api";
import type { TraceSelection } from "../types";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

const io = vi.hoisted(() => ({ data: undefined as Partial<SpanIO> | undefined }));
vi.mock("../hooks", () => ({
  useSpanIO: (_p: string, _t: string, spanId: string | null) => ({
    data: spanId ? io.data : undefined,
    isLoading: false,
  }),
}));

vi.mock("@/components/ui/expandable-section", () => ({
  ExpandableSection: ({ children, title }: { children: ReactNode; title: string }) => (
    <div data-testid={`section-${title.toLowerCase()}`}>{children}</div>
  ),
}));

import { SpanInfoPanel } from "./SpanInfoPanel";

afterEach(() => cleanup());

const IN = "1".repeat(64);
const OUT = "2".repeat(64);
const META = "3".repeat(64);
const ref = (hash: string) => `traceroot-attachment://v1/sha256/${hash}?bytes=68&mime=image/png`;
const url = (spanId: string, hash: string) =>
  `/api/projects/proj-1/traces/trace-1/spans/${spanId}/attachments/${hash}`;

function makeSpan(overrides: Partial<Span> = {}): Span {
  return {
    span_id: "root-span",
    trace_id: "trace-1",
    parent_span_id: null,
    name: "agent",
    span_kind: "SPAN",
    span_start_time: "2026-07-17T10:24:00.000Z",
    span_end_time: "2026-07-17T10:24:02.500Z",
    status: SpanStatus.OK,
    status_message: null,
    error_type: "",
    model_name: null,
    cost: null,
    input_tokens: null,
    output_tokens: null,
    total_tokens: null,
    git_source_file: null,
    git_source_line: null,
    git_source_function: null,
    ...overrides,
  };
}

function makeTrace(spans: Span[]): TraceDetail {
  return {
    trace_id: "trace-1",
    project_id: "proj-1",
    name: "agent",
    trace_start_time: "2026-07-17T10:24:00.000Z",
    user_id: null,
    session_id: null,
    git_ref: null,
    git_repo: null,
    environment: "default",
    release: null,
    input: JSON.stringify({ image: ref(IN) }),
    output: ref(OUT),
    metadata: JSON.stringify({ shot: ref(META) }),
    spans,
  };
}

function imageIn(section: string): string | null {
  const img = within(screen.getByTestId(`section-${section}`)).queryByRole("img");
  return img ? img.getAttribute("src") : null;
}

const CHILD = makeSpan({ span_id: "tool-span", parent_span_id: "root-span", name: "screenshot" });

beforeEach(() => {
  io.data = {
    span_id: "tool-span",
    trace_id: "trace-1",
    input: ref(IN),
    output: JSON.stringify([{ type: "input_image", image_url: ref(OUT) }]),
    metadata: JSON.stringify({ shot: ref(META) }),
  };
});

describe("SpanInfoPanel image attachments", () => {
  it("loads a span's images through that span", () => {
    const selection: TraceSelection = { type: "span", span: CHILD };
    render(
      <SpanInfoPanel
        projectId="proj-1"
        trace={makeTrace([makeSpan(), CHILD])}
        selection={selection}
      />,
    );

    expect(imageIn("input")).toBe(url("tool-span", IN));
    expect(imageIn("output")).toBe(url("tool-span", OUT));
    expect(imageIn("metadata")).toBe(url("tool-span", META));
  });

  it("loads trace input and output through the root span, and keeps trace metadata as text", () => {
    const pendingRoot = makeSpan({ span_id: "placeholder", pending: true });
    render(
      <SpanInfoPanel
        projectId="proj-1"
        trace={makeTrace([pendingRoot, CHILD, makeSpan()])}
        selection={{ type: "trace" }}
      />,
    );

    expect(imageIn("input")).toBe(url("root-span", IN));
    expect(imageIn("output")).toBe(url("root-span", OUT));
    expect(imageIn("metadata")).toBeNull();
  });

  it("keeps trace references as text when the root span is missing", () => {
    render(
      <SpanInfoPanel projectId="proj-1" trace={makeTrace([CHILD])} selection={{ type: "trace" }} />,
    );

    expect(imageIn("input")).toBeNull();
    expect(imageIn("output")).toBeNull();
    expect(screen.getByText(`"${ref(OUT)}"`)).toBeDefined();
  });

  it("keeps references as text on an evaluation's reconstructed trace", () => {
    render(
      <SpanInfoPanel
        projectId="proj-1"
        trace={makeTrace([makeSpan(), CHILD])}
        selection={{ type: "span", span: CHILD }}
        isEvalShaped
      />,
    );

    expect(imageIn("input")).toBeNull();
    expect(imageIn("output")).toBeNull();
    expect(imageIn("metadata")).toBeNull();
  });
});
