import { describe, expect, it, vi } from "vitest";
import { runAll, runScenario } from "../runner.js";
import type { EvalPrisma, Scenario, TurnTranscript } from "../types.js";

function makeDeps(overrides: Partial<Parameters<typeof runScenario>[1]> = {}) {
  const sendMessage = vi.fn(
    async (_p: string, sessionId: string, message: string): Promise<TurnTranscript> => ({
      sessionId,
      message,
      toolCalls: [],
      toolResults: [],
      assistantText: "ok",
      events: [],
    }),
  );
  let n = 0;
  const client = {
    createSession: vi.fn(async () => `sess-${++n}`),
    sendMessage,
    deleteSession: vi.fn(async () => {}),
  };
  const prisma = {
    detector: { findMany: vi.fn().mockResolvedValue([]) },
    dashboard: { findMany: vi.fn().mockResolvedValue([]) },
  } as unknown as EvalPrisma;

  return {
    client,
    prisma,
    fixture: {
      runId: "r1",
      user: { id: "u-1", email: "eval@example.com", workspaceId: "ws-1" },
      projectId: "proj-1",
      projectName: "agent-eval-r1",
    },
    probeWidgetQuery: vi.fn(async () => 200),
    canonicalPrompt: () => "CANON",
    ...overrides,
  } as unknown as Parameters<typeof runScenario>[1] & { client: typeof client };
}

const scenario = (overrides: Partial<Scenario> = {}): Scenario => ({
  name: "demo",
  messages: ["do the thing"],
  assert: () => {},
  ...overrides,
});

describe("runScenario", () => {
  it("passes when the assertions hold", async () => {
    const result = await runScenario(scenario(), makeDeps());

    expect(result.passed).toBe(true);
    expect(result.error).toBeUndefined();
    expect(result.name).toBe("demo");
    expect(result.durationMs).toEqual(expect.any(Number));
  });

  it("sends every message into one session by default", async () => {
    const deps = makeDeps();
    await runScenario(scenario({ messages: ["one", "two"] }), deps);

    expect(deps.client.createSession).toHaveBeenCalledTimes(1);
    expect(deps.client.sendMessage.mock.calls.map((c) => [c[1], c[2]])).toEqual([
      ["sess-1", "one"],
      ["sess-1", "two"],
    ]);
  });

  it("gives each message its own session when the scenario asks for it", async () => {
    const deps = makeDeps();
    await runScenario(scenario({ messages: ["one", "two"], sessionPerMessage: true }), deps);

    expect(deps.client.createSession).toHaveBeenCalledTimes(2);
    expect(deps.client.sendMessage.mock.calls.map((c) => c[1])).toEqual(["sess-1", "sess-2"]);
  });

  it("records the turns it collected", async () => {
    const result = await runScenario(scenario({ messages: ["one", "two"] }), makeDeps());
    expect(result.turns.map((t) => t.message)).toEqual(["one", "two"]);
  });

  it("fails with the assertion message instead of throwing", async () => {
    const result = await runScenario(
      scenario({
        assert: () => {
          throw new Error("template was not failure");
        },
      }),
      makeDeps(),
    );

    expect(result.passed).toBe(false);
    expect(result.error).toBe("template was not failure");
  });

  it("fails with the transport error when the turn itself breaks", async () => {
    const deps = makeDeps();
    deps.client.sendMessage.mockRejectedValue(new Error("turn timed out"));

    const result = await runScenario(scenario(), deps);

    expect(result.passed).toBe(false);
    expect(result.error).toBe("turn timed out");
  });

  it("deletes the sessions it opened, even after a failed assertion", async () => {
    const deps = makeDeps();
    await runScenario(
      scenario({
        assert: () => {
          throw new Error("nope");
        },
      }),
      deps,
    );

    expect(deps.client.deleteSession).toHaveBeenCalledWith("proj-1", "sess-1");
  });

  it("hands the assertions the rows the scenario created", async () => {
    const deps = makeDeps();
    (deps.prisma.detector.findMany as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: "d-1", name: "Failures", template: "failure", prompt: "p" }]);

    const seen: string[] = [];
    await runScenario(
      scenario({
        assert: (ctx) => {
          seen.push(...ctx.created.detectors.map((d) => d.id));
        },
      }),
      deps,
    );

    expect(seen).toEqual(["d-1"]);
  });

  it("passes the widget probe through to the assertions unchanged", async () => {
    const deps = makeDeps();
    await runScenario(
      scenario({
        assert: async (ctx) => {
          await ctx.probeWidgetQuery({ view: "spans" });
        },
      }),
      deps,
    );

    expect(deps.probeWidgetQuery).toHaveBeenCalledWith({ view: "spans" });
  });

  it("still reports a result when session cleanup fails", async () => {
    const deps = makeDeps();
    deps.client.deleteSession.mockRejectedValue(new Error("already gone"));

    await expect(runScenario(scenario(), deps)).resolves.toMatchObject({ passed: true });
  });
});

describe("runAll", () => {
  it("runs the scenarios in order and returns one result each", async () => {
    const order: string[] = [];
    const scenarios = ["a", "b", "c"].map((name) =>
      scenario({
        name,
        assert: () => {
          order.push(name);
        },
      }),
    );

    const results = await runAll(scenarios, makeDeps());

    expect(order).toEqual(["a", "b", "c"]);
    expect(results.map((r) => r.name)).toEqual(["a", "b", "c"]);
  });

  it("keeps going after a failing scenario", async () => {
    const scenarios = [
      scenario({
        name: "a",
        assert: () => {
          throw new Error("boom");
        },
      }),
      scenario({ name: "b" }),
    ];

    const results = await runAll(scenarios, makeDeps());
    expect(results.map((r) => r.passed)).toEqual([false, true]);
  });

  it("reports each finished scenario to the transcript sink", async () => {
    const onResult = vi.fn();
    await runAll([scenario({ name: "a" })], makeDeps({ onResult } as never));

    expect(onResult).toHaveBeenCalledWith(expect.objectContaining({ name: "a" }));
  });

  it("keeps running the remaining scenarios when the transcript sink throws", async () => {
    // The sink writes a file; a full disk or a bad path must not throw away
    // the scenarios that have not run yet.
    const onResult = vi.fn((result: { name: string }) => {
      if (result.name === "a") throw new Error("ENOSPC");
    });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    const results = await runAll(
      [scenario({ name: "a" }), scenario({ name: "b" })],
      makeDeps({ onResult } as never),
    );

    expect(results.map((r) => r.name)).toEqual(["a", "b"]);
    expect(results.every((r) => r.passed)).toBe(true);
    expect(consoleError).toHaveBeenCalledWith(expect.stringContaining("ENOSPC"));
    consoleError.mockRestore();
  });
});
