import { newRows, readProjectRows } from "./assertions.js";
import type { EvalFixture, EvalPrisma, Scenario, ScenarioResult, TurnTranscript } from "./types.js";

/** The slice of `AgentClient` the runner needs, so tests can pass a fake. */
export interface RunnerClient {
  createSession(projectId: string, title?: string): Promise<string>;
  sendMessage(projectId: string, sessionId: string, message: string): Promise<TurnTranscript>;
  deleteSession(projectId: string, sessionId: string): Promise<void>;
}

export interface RunnerDeps {
  client: RunnerClient;
  prisma: EvalPrisma;
  fixture: EvalFixture;
  probeWidgetQuery: (spec: unknown) => Promise<number>;
  canonicalPrompt: (templateId: string) => string;
  /** Called as each scenario finishes, so transcripts can be written eagerly. */
  onResult?: (result: ScenarioResult) => void | Promise<void>;
}

/**
 * Run one scenario against the live service.
 *
 * Project rows are read before and after the turns so assertions see exactly
 * what this scenario created, rather than everything earlier scenarios left in
 * the shared fixture project. A failed assertion becomes a failed result, not
 * a thrown error — the run always finishes and always scores every scenario.
 */
export async function runScenario(scenario: Scenario, deps: RunnerDeps): Promise<ScenarioResult> {
  const { projectId } = deps.fixture;
  const startedAt = Date.now();
  const sessionIds: string[] = [];
  const turns: TurnTranscript[] = [];
  let error: string | undefined;

  const openSession = async (): Promise<string> => {
    const sessionId = await deps.client.createSession(projectId, `eval: ${scenario.name}`);
    sessionIds.push(sessionId);
    return sessionId;
  };

  try {
    const before = await readProjectRows(deps.prisma, projectId);

    let sessionId = await openSession();
    for (const [index, message] of scenario.messages.entries()) {
      // A fresh session per message is what makes the idempotency check
      // meaningful: the second ask must not lean on the first one's context.
      if (index > 0 && scenario.sessionPerMessage) sessionId = await openSession();
      turns.push(await deps.client.sendMessage(projectId, sessionId, message));
    }

    const after = await readProjectRows(deps.prisma, projectId);

    await scenario.assert({
      fixture: deps.fixture,
      turns,
      before,
      after,
      created: newRows(before, after),
      probeWidgetQuery: deps.probeWidgetQuery,
      canonicalPrompt: deps.canonicalPrompt,
      prisma: deps.prisma,
    });
  } catch (failure) {
    error = failure instanceof Error ? failure.message : String(failure);
  } finally {
    for (const sessionId of sessionIds) {
      await deps.client.deleteSession(projectId, sessionId).catch(() => {});
    }
  }

  return {
    name: scenario.name,
    passed: error === undefined,
    error,
    durationMs: Date.now() - startedAt,
    turns,
  };
}

/** Run every scenario in order; one failure never stops the rest. */
export async function runAll(scenarios: Scenario[], deps: RunnerDeps): Promise<ScenarioResult[]> {
  const results: ScenarioResult[] = [];
  for (const scenario of scenarios) {
    const result = await runScenario(scenario, deps);
    results.push(result);
    // The sink writes a transcript file. A failure there says nothing about
    // the scenario that just passed and must not cost the ones still queued,
    // so it is logged and the run carries on.
    try {
      await deps.onResult?.(result);
    } catch (failure) {
      const reason = failure instanceof Error ? failure.message : String(failure);
      console.error(`could not report the result for "${scenario.name}": ${reason}`);
    }
  }
  return results;
}
