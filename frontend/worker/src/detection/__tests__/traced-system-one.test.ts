import { describe, it, expect, vi, beforeEach, beforeAll } from "vitest";
import { SimpleSpanProcessor, InMemorySpanExporter } from "@opentelemetry/sdk-trace-node";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { SpanStatusCode, trace } from "@opentelemetry/api";

const { mockInitialize, mockFlush, mockShutdown } = vi.hoisted(() => ({
  mockInitialize: vi.fn(),
  mockFlush: vi.fn(),
  mockShutdown: vi.fn(),
}));
// SDK stand-in, as in traced-complete.test.ts: observe opens a REAL active
// span so the System One child parents into it.
vi.mock("@traceroot-ai/traceroot", () => ({
  TraceRoot: {
    initialize: mockInitialize,
    flush: mockFlush,
    shutdown: mockShutdown,
    isTracingActive: () => true,
  },
  observe: async (opts: { name: string }, fn: () => Promise<unknown>) =>
    trace.getTracer("sdk").startActiveSpan(opts.name, async (span) => {
      try {
        return await fn();
      } finally {
        span.end();
      }
    }),
}));

import { tracedSystemOne } from "../traced-system-one.js";
import { withSelfTrace } from "../self-trace-emitter.js";
import type { SystemOneQuestion, SystemOneResult } from "../typesafe-client.js";

const QUESTIONS: Record<string, SystemOneQuestion> = {
  gate: {
    type: "noul",
    instructions: {
      detector_criteria: "Flag traces where a tool call fails.",
      question: "Does `trace` exhibit any problem described in `detector_criteria`?",
    },
    criteria: { true: "At least one problem.", false: "No problem." },
  },
};

// After the client's camelCase mapping.
const RESULT = {
  answers: {
    gate: { type: "noul", noul: 0.97 },
    label: {
      type: "choice",
      choice: "tool_error",
      confidence: 0.97,
      probabilities: { tool_error: 0.97, none: 0.03 },
    },
  },
  usage: { inputTokens: 810, outputTokens: 63 },
  model: "jev-1.13.0",
} as unknown as SystemOneResult;

const TRACE_META = {
  model: "jev-1.13.0",
  questions: QUESTIONS,
  statePreview: JSON.stringify({ trace: { trace_id: "t-1", span_count: 3, spans: [] } }),
  stateStats: { span_count: 3, omitted_spans: 0 },
};

const META = {
  traceId: "aaaaaaaabbbbccccddddeeeeeeeeeeee",
  projectId: "proj-1",
  name: "detector-run: Tool failure",
  metadata: { detectorId: "det-1", detectorName: "Tool failure", scannedTraceId: "trace-1" },
};

const exporter = new InMemorySpanExporter();
const call = vi.fn<() => Promise<SystemOneResult>>();

beforeAll(() => {
  new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] }).register();
});

beforeEach(() => {
  call.mockReset();
  call.mockResolvedValue(RESULT);
  vi.stubEnv("INTERNAL_API_SECRET", "test-secret");
  exporter.reset();
});

const systemOneSpan = () =>
  exporter.getFinishedSpans().find((s) => s.name.startsWith("systemone "));

describe("tracedSystemOne outside a self-trace scope", () => {
  it("passes through without creating any span", async () => {
    const res = await tracedSystemOne(TRACE_META, call);
    expect(res).toBe(RESULT);
    expect(call).toHaveBeenCalledTimes(1);
    expect(exporter.getFinishedSpans()).toHaveLength(0);
  });
});

describe("tracedSystemOne inside a self-trace scope", () => {
  it("draws a `systemone <model>` LLM child span with model, tokens, and I/O", async () => {
    const run = await withSelfTrace(META, () => tracedSystemOne(TRACE_META, call));
    expect(run.ok && run.value).toBe(RESULT);

    const spans = exporter.getFinishedSpans();
    const root = spans.find((s) => s.name.startsWith("detector-run"))!;
    const span = systemOneSpan()!;
    expect(span.name).toBe("systemone jev-1.13.0");
    expect(span.parentSpanContext?.spanId).toBe(root.spanContext().spanId);
    expect(span.spanContext().traceId).toBe(root.spanContext().traceId);

    expect(span.attributes["traceroot.source"]).toBeUndefined();
    expect(span.attributes["traceroot.project_id"]).toBe("proj-1");
    expect(span.attributes["traceroot.span.type"]).toBe("LLM");
    expect(span.attributes["traceroot.llm.model"]).toBe("jev-1.13.0");
    expect(span.attributes["gen_ai.usage.input_tokens"]).toBe(810);
    expect(span.attributes["gen_ai.usage.output_tokens"]).toBe(63);
    expect(span.status.code).not.toBe(SpanStatusCode.ERROR);

    const input = JSON.parse(String(span.attributes["traceroot.span.input"])) as {
      questions: Record<string, SystemOneQuestion>;
      state_preview: string;
      state_stats: Record<string, number>;
    };
    expect(input.questions).toEqual(QUESTIONS);
    expect(input.state_preview).toBe(TRACE_META.statePreview);
    expect(input.state_stats).toEqual({ span_count: 3, omitted_spans: 0 });

    const output = JSON.parse(String(span.attributes["traceroot.span.output"]));
    expect(output).toEqual(RESULT.answers);
  });

  it("runs the call with the System One span active", async () => {
    let activeSpanId: string | undefined;
    call.mockImplementation(async () => {
      activeSpanId = trace.getActiveSpan()?.spanContext().spanId;
      return RESULT;
    });
    await withSelfTrace(META, () => tracedSystemOne(TRACE_META, call));
    expect(activeSpanId).toBe(systemOneSpan()!.spanContext().spanId);
  });

  it("records the response's model id over the requested one", async () => {
    call.mockResolvedValue({ ...RESULT, model: "jev-1.13.1" });
    await withSelfTrace(META, () => tracedSystemOne(TRACE_META, call));
    expect(systemOneSpan()!.attributes["traceroot.llm.model"]).toBe("jev-1.13.1");
  });

  it("marks a thrown call as errored and rethrows", async () => {
    call.mockRejectedValue(new Error("TypeSafe returned 401"));
    const run = await withSelfTrace(META, () => tracedSystemOne(TRACE_META, call));
    expect(run.ok).toBe(false);

    const span = systemOneSpan()!;
    expect(span.status.code).toBe(SpanStatusCode.ERROR);
    expect(span.status.message).toBe("TypeSafe returned 401");
  });

  it("degrades to an untraced call when the questions cannot be serialized", async () => {
    // A BigInt makes JSON.stringify throw; span setup is best-effort, so the
    // call still returns its result and never throws into the detector run.
    const unserializable = { ...TRACE_META, questions: { gate: { type: "noul", x: 10n } } };
    let result: unknown;
    const run = await withSelfTrace(META, async () => {
      result = await tracedSystemOne(unserializable as never, call);
      return "ok";
    });
    expect(run.ok).toBe(true);
    expect(result).toBe(RESULT);
    expect(systemOneSpan()).toBeUndefined();
  });
});
