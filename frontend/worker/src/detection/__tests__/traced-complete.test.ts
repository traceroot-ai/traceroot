import { describe, it, expect, vi, beforeEach, beforeAll } from "vitest";
import { SimpleSpanProcessor, InMemorySpanExporter } from "@opentelemetry/sdk-trace-node";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { SpanStatusCode, trace } from "@opentelemetry/api";

const { mockComplete, mockInitialize, mockFlush, mockShutdown } = vi.hoisted(() => ({
  mockComplete: vi.fn(),
  mockInitialize: vi.fn(),
  mockFlush: vi.fn(),
  mockShutdown: vi.fn(),
}));
vi.mock("@earendil-works/pi-ai/compat", () => ({ complete: mockComplete }));
// SDK stand-in: initialize is a no-op (a real provider is registered below);
// observe opens a REAL active span so the shim's child parents into it, the
// way the SDK's startActiveSpan does.
vi.mock("@traceroot-ai/traceroot", () => ({
  TraceRoot: { initialize: mockInitialize, flush: mockFlush, shutdown: mockShutdown },
  observe: async (opts: { name: string }, fn: () => Promise<unknown>) =>
    trace.getTracer("sdk").startActiveSpan(opts.name, async (span) => {
      try {
        return await fn();
      } finally {
        span.end();
      }
    }),
}));

import { tracedComplete, LLM_IO_CAP } from "../traced-complete.js";
import { withSelfTrace } from "../self-trace-emitter.js";

const MODEL = { id: "claude-opus-4-8", provider: "anthropic", api: "anthropic-messages" };
const CTX = {
  systemPrompt: "You are a judge.",
  messages: [{ role: "user", content: "DETECTOR: Failure...", timestamp: 1 }],
  tools: [],
};
const RESPONSE = {
  role: "assistant",
  content: [
    { type: "toolCall", name: "submit_result", arguments: { identified: true, summary: "found" } },
  ],
  stopReason: "toolUse",
  model: "claude-opus-4-8-20260115",
  provider: "anthropic",
  // pi-ai's Usage: `input` is UNCACHED input only; the prompt bulk lives in
  // the cache buckets (Anthropic reports input_tokens exclusive of cache).
  usage: {
    input: 2,
    output: 45,
    cacheRead: 900,
    cacheWrite: 4100,
    cacheWrite1h: 0,
    cost: { total: 0.02 },
  },
};

const META = {
  runId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
  projectId: "proj-1",
  detectorId: "det-1",
  detectorName: "Latency spike",
  scannedTraceId: "trace-1",
};

const exporter = new InMemorySpanExporter();

beforeAll(() => {
  new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] }).register();
});

beforeEach(() => {
  mockComplete.mockReset();
  mockComplete.mockResolvedValue(RESPONSE);
  vi.stubEnv("INTERNAL_API_SECRET", "test-secret");
  exporter.reset();
});

describe("tracedComplete outside a self-trace scope", () => {
  it("passes through without creating any span", async () => {
    const res = await tracedComplete(MODEL as never, CTX as never, {} as never);
    expect(res).toBe(RESPONSE);
    expect(mockComplete).toHaveBeenCalledWith(MODEL, CTX, {});
    expect(exporter.getFinishedSpans()).toHaveLength(0);
  });
});

describe("tracedComplete inside a self-trace scope", () => {
  it("draws a real LLM child span with transcript, model, and tokens", async () => {
    await withSelfTrace(META, () => tracedComplete(MODEL as never, CTX as never, {} as never));

    const spans = exporter.getFinishedSpans();
    const root = spans.find((s) => s.name.startsWith("detector-run"))!;
    const llm = spans.find((s) => s.name === "chat claude-opus-4-8")!;
    expect(llm.parentSpanContext?.spanId).toBe(root.spanContext().spanId);
    expect(llm.spanContext().traceId).toBe(root.spanContext().traceId);

    expect(llm.attributes["traceroot.source"]).toBe("detector");
    expect(llm.attributes["traceroot.project_id"]).toBe("proj-1");
    expect(llm.attributes["traceroot.span.type"]).toBe("LLM");
    // Response model (dated snapshot) wins over the requested id.
    expect(llm.attributes["traceroot.llm.model"]).toBe("claude-opus-4-8-20260115");
    expect(llm.attributes["gen_ai.usage.input_tokens"]).toBe(2);
    expect(llm.attributes["gen_ai.usage.output_tokens"]).toBe(45);
    // Cache buckets ride along so the transform reconstructs GROSS input
    // (2 + 900 + 4100) and prices each bucket at its own rate.
    expect(llm.attributes["gen_ai.usage.cache_read.input_tokens"]).toBe(900);
    expect(llm.attributes["gen_ai.usage.cache_creation.input_tokens"]).toBe(4100);
    expect(llm.attributes["gen_ai.usage.cache_creation.ephemeral_1h_input_tokens"]).toBeUndefined();

    const input = String(llm.attributes["traceroot.span.input"]);
    expect(input).toContain("You are a judge.");
    expect(input).toContain("DETECTOR: Failure...");
    const output = String(llm.attributes["traceroot.span.output"]);
    expect(output).toContain("submit_result");
    expect(output).toContain("found");
  });

  it("truncates oversized transcripts inside the structure, keeping valid JSON", async () => {
    const huge = { ...CTX, messages: [{ role: "user", content: "x".repeat(LLM_IO_CAP * 3) }] };
    await withSelfTrace(META, () => tracedComplete(MODEL as never, huge as never, {} as never));

    const llm = exporter.getFinishedSpans().find((s) => s.name.startsWith("chat"))!;
    const recorded = String(llm.attributes["traceroot.span.input"]);
    // The record must stay parseable — the trace view pretty-renders JSON
    // inputs and falls back to raw text on a parse failure, so a cap that
    // slices the serialized JSON mid-string would break rendering.
    const parsed = JSON.parse(recorded) as {
      systemPrompt: string;
      messages: { role: string; content: string }[];
    };
    expect(parsed.systemPrompt).toBe(CTX.systemPrompt);
    expect(parsed.messages[0].content.length).toBeLessThanOrEqual(LLM_IO_CAP + 1);
    expect(parsed.messages[0].content.endsWith("…")).toBe(true);
  });

  it("never splits a surrogate pair at the truncation cap", async () => {
    // An emoji (surrogate pair) straddling the cap: a naive slice would leave
    // a dangling high surrogate as the last recorded character.
    const straddling = `${"x".repeat(LLM_IO_CAP - 1)}😀${"y".repeat(100)}`;
    const huge = { ...CTX, messages: [{ role: "user", content: straddling }] };
    await withSelfTrace(META, () => tracedComplete(MODEL as never, huge as never, {} as never));

    const llm = exporter.getFinishedSpans().find((s) => s.name.startsWith("chat"))!;
    const parsed = JSON.parse(String(llm.attributes["traceroot.span.input"])) as {
      messages: { content: string }[];
    };
    const content = parsed.messages[0].content;
    expect(content.endsWith("…")).toBe(true);
    // The dangling high surrogate was dropped, not recorded.
    const beforeEllipsis = content.charCodeAt(content.length - 2);
    expect(beforeEllipsis >= 0xd800 && beforeEllipsis <= 0xdbff).toBe(false);
  });

  it("marks aborted (timed-out) responses as errored spans", async () => {
    // sandbox-eval's watchdog timeout resolves with stopReason "aborted"
    // instead of throwing — the span must not read as a healthy call.
    mockComplete.mockResolvedValue({
      ...RESPONSE,
      content: [],
      stopReason: "aborted",
    });
    await withSelfTrace(META, () => tracedComplete(MODEL as never, CTX as never, {} as never));

    const llm = exporter.getFinishedSpans().find((s) => s.name.startsWith("chat"))!;
    expect(llm.status.code).toBe(SpanStatusCode.ERROR);
    expect(llm.status.message).toBe("aborted (timeout)");
  });

  it("marks provider-error responses as errored spans", async () => {
    mockComplete.mockResolvedValue({
      ...RESPONSE,
      content: [],
      stopReason: "error",
      errorMessage: "401 bad key",
    });
    await withSelfTrace(META, () => tracedComplete(MODEL as never, CTX as never, {} as never));

    const llm = exporter.getFinishedSpans().find((s) => s.name.startsWith("chat"))!;
    expect(llm.status.code).toBe(SpanStatusCode.ERROR);
    expect(llm.status.message).toBe("401 bad key");
  });

  it("marks thrown calls as errored and rethrows", async () => {
    mockComplete.mockRejectedValue(new Error("network down"));
    const run = await withSelfTrace(META, () =>
      tracedComplete(MODEL as never, CTX as never, {} as never),
    );
    expect(run.ok).toBe(false);

    const llm = exporter.getFinishedSpans().find((s) => s.name.startsWith("chat"))!;
    expect(llm.status.code).toBe(SpanStatusCode.ERROR);
    expect(llm.status.message).toBe("network down");
  });

  it("a retried eval produces one span per attempt", async () => {
    await withSelfTrace(META, async () => {
      await tracedComplete(MODEL as never, CTX as never, {} as never);
      await tracedComplete(MODEL as never, CTX as never, {} as never);
    });
    const llmSpans = exporter.getFinishedSpans().filter((s) => s.name.startsWith("chat"));
    expect(llmSpans).toHaveLength(2);
  });
});
