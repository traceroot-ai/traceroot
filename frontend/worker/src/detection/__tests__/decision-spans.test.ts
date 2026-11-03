import { describe, it, expect, vi, beforeEach, beforeAll } from "vitest";
import { SimpleSpanProcessor, InMemorySpanExporter } from "@opentelemetry/sdk-trace-node";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { trace } from "@opentelemetry/api";

// Each decision backend's DECISION span, end to end through the real wrapper:
// the OpenInference attributes ingest reads, pinned per provider.

const { mockCallDecisions, mockCalculateCost, mockCallSystemOne } = vi.hoisted(() => ({
  mockCallDecisions: vi.fn(),
  mockCalculateCost: vi.fn(),
  mockCallSystemOne: vi.fn(),
}));

// SDK stand-in, as in traced-system-one.test.ts.
vi.mock("@traceroot-ai/traceroot", () => ({
  TraceRoot: {
    initialize: vi.fn(),
    flush: vi.fn(),
    shutdown: vi.fn(),
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
vi.mock("../openai-decisions-client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../openai-decisions-client.js")>()),
  callDecisions: mockCallDecisions,
}));
vi.mock("@traceroot/core", () => ({ calculateCost: mockCalculateCost }));
vi.mock("../typesafe-client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../typesafe-client.js")>()),
  callSystemOne: mockCallSystemOne,
}));

import { runJevDetection } from "../jev-eval.js";
import { runOpenAIDecisionDetection } from "../openai-decision-eval.js";
import { withSelfTrace } from "../self-trace-emitter.js";

const META = {
  traceId: "aaaaaaaabbbbccccddddeeeeeeeeeeee",
  projectId: "proj-1",
  name: "detector-run: Failure",
  metadata: { detectorId: "det-1", detectorName: "Failure", scannedTraceId: "trace-1" },
};

const SPANS = '{"trace_id":"t-1","span_id":"s1","name":"tool.get_weather","status":"ERROR"}';

const exporter = new InMemorySpanExporter();

beforeAll(() => {
  new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] }).register();
});

beforeEach(() => {
  vi.stubEnv("INTERNAL_API_SECRET", "test-secret");
  exporter.reset();
  mockCallDecisions.mockReset();
  mockCallSystemOne.mockReset();
  mockCalculateCost.mockReset();
  mockCalculateCost.mockResolvedValue(0.000042);
});

/** The span's attributes minus the bounded I/O payloads. */
function decisionAttributes(name: string) {
  const span = exporter.getFinishedSpans().find((s) => s.name === name);
  expect(span, `no "${name}" span`).toBeDefined();
  const {
    "traceroot.span.input": input,
    "traceroot.span.output": _output,
    ...rest
  } = span!.attributes;
  expect(typeof input).toBe("string");
  return { span: span!, attributes: rest };
}

describe("Jev span", () => {
  it("adds decision.system and otherwise records what it always has", async () => {
    mockCallSystemOne.mockResolvedValueOnce({
      model: "jev-1.13.0",
      answers: {
        gate: { type: "noul", noul: 0.9 },
        label: {
          type: "choice",
          choice: "problem",
          confidence: 0.8,
          probabilities: { problem: 0.8, none: 0.2 },
        },
      },
      usage: { inputTokens: 810, outputTokens: 63 },
    });

    const run = await withSelfTrace(META, () =>
      runJevDetection({
        spansJsonl: SPANS,
        detector: {
          id: "det-1",
          name: "Failure",
          prompt: "Flag tool failures.",
          outputSchema: [],
          detectionModel: "jev-1.13.0",
          detectionProvider: "my-typesafe",
          detectionSource: "byok",
          template: "blank",
        },
        providerConfig: { adapter: "typesafe", key: "ts-key", baseUrl: null, config: null },
        timeoutMs: 5_000,
      }),
    );
    expect(run.ok).toBe(true);

    const { attributes } = decisionAttributes("systemone jev-1.13.0");
    expect(attributes).toEqual({
      "traceroot.project_id": "proj-1",
      "traceroot.span.type": "DECISION",
      "traceroot.llm.model": "jev-1.13.0",
      "decision.system": "typesafe",
      "gen_ai.usage.input_tokens": 810,
      "gen_ai.usage.output_tokens": 63,
    });
    // Jev's run is still priced by the run processor's token-count fallback.
    expect(run.ok && run.value.inferenceCost).toBe(0);
    expect(mockCalculateCost).not.toHaveBeenCalled();
  });
});

describe("OpenAI Decisions span", () => {
  const runOpenAI = () =>
    runOpenAIDecisionDetection({
      spansJsonl: SPANS,
      detector: {
        id: "det-1",
        name: "Failure",
        prompt: "Flag tool failures.",
        outputSchema: [],
        detectionModel: "gpt-6-luna-decisions",
        detectionProvider: "my-openai",
        detectionSource: "byok",
        template: "blank",
      },
      providerConfig: { adapter: "openai", key: "sk-key", baseUrl: null, config: null },
      timeoutMs: 5_000,
    });

  it("records gpt-6-luna with decision.* attributes, the reported tokens and the run's cost", async () => {
    mockCallDecisions.mockResolvedValueOnce({
      model: null,
      answers: {
        gate: { type: "predicate", probability: 0.9 },
        label: {
          type: "choice",
          choice: "problem",
          confidence: 0.8,
          probabilities: { problem: 0.8, none: 0.2 },
        },
      },
      usage: { inputTokens: 1_000, cachedTokens: 600, cacheWriteTokens: 100, outputTokens: 7 },
    });

    const run = await withSelfTrace(META, runOpenAI);
    expect(run.ok).toBe(true);
    const result = run.ok ? run.value : null;

    const { attributes } = decisionAttributes("decisions gpt-6-luna");
    expect(attributes).toEqual({
      "traceroot.project_id": "proj-1",
      "traceroot.span.type": "DECISION",
      "traceroot.llm.model": "gpt-6-luna",
      "decision.system": "openai",
      "decision.provider": "openai",
      "decision.model_name": "gpt-6-luna",
      "gen_ai.usage.input_tokens": 1_000,
      "gen_ai.usage.output_tokens": 7,
      "gen_ai.usage.cache_read.input_tokens": 600,
      "gen_ai.usage.cache_creation.input_tokens": 100,
      "decision.token_count.input": 1_000,
      "decision.token_count.output": 7,
      "llm.cost.total": 0.000042,
    });
    // The detector run and its self-trace record the same cost.
    expect(result?.inferenceCost).toBe(attributes["llm.cost.total"]);
  });

  it("redacts a credential-shaped key inside the trace before recording it", async () => {
    mockCallDecisions.mockResolvedValueOnce({
      model: null,
      answers: {
        gate: { type: "predicate", probability: 0.1 },
        label: {
          type: "choice",
          choice: "none",
          confidence: 0.9,
          probabilities: { problem: 0.1, none: 0.9 },
        },
      },
      usage: { inputTokens: 10, cachedTokens: 0, cacheWriteTokens: 0, outputTokens: 0 },
    });

    await withSelfTrace(META, () =>
      runOpenAIDecisionDetection({
        spansJsonl:
          '{"trace_id":"t-1","span_id":"s1","name":"tool.fetch",' +
          '"input":"{\\"apiKey\\":\\"sk-live-123\\",\\"city\\":\\"Paris\\"}"}',
        detector: {
          id: "det-1",
          name: "Failure",
          prompt: "Flag tool failures.",
          outputSchema: [],
          detectionModel: "gpt-6-luna-decisions",
          detectionProvider: "my-openai",
          detectionSource: "byok",
          template: "blank",
        },
        providerConfig: { adapter: "openai", key: "sk-key", baseUrl: null, config: null },
        timeoutMs: 5_000,
      }),
    );

    const span = exporter.getFinishedSpans().find((s) => s.name === "decisions gpt-6-luna")!;
    const input = String(span.attributes["traceroot.span.input"]);
    expect(input).not.toContain("sk-live-123");
    expect(input).toContain("[REDACTED]");
    expect(input).toContain("Paris");
    // The model still received the trace as it was.
    const sent = mockCallDecisions.mock.calls[0][0].input[0].content[0].data;
    expect(JSON.stringify(sent)).toContain("sk-live-123");
  });

  it("records a refusal's billed tokens and cost on the errored span", async () => {
    mockCallDecisions.mockRejectedValueOnce(
      Object.assign(new Error('OpenAI decisions refused to answer question "label"'), {
        usage: { inputTokens: 40, cachedTokens: 0, cacheWriteTokens: 0, outputTokens: 0 },
      }),
    );

    expect((await withSelfTrace(META, runOpenAI)).ok).toBe(false);

    const { span, attributes } = decisionAttributes("decisions gpt-6-luna");
    expect(span.status.message).toBe('OpenAI decisions refused to answer question "label"');
    expect(attributes).toMatchObject({
      "decision.system": "openai",
      "gen_ai.usage.input_tokens": 40,
      "decision.token_count.input": 40,
      "llm.cost.total": 0.000042,
    });
  });
});
