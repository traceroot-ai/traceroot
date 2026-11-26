/**
 * Whether a Loop run's window holds any customer trace: the run skips the
 * agent when it holds none. Asks the same route the Loop agent's list_traces
 * reads (with the same service auth), so the answer follows its filters:
 * customer traffic only (no detector or agent self-traces), no offline
 * evaluation traces.
 */
const BACKEND_URL = process.env.BACKEND_INTERNAL_URL || "http://localhost:8000";
const CHECK_TIMEOUT_MS = 15_000;

/**
 * The start of a run's window: `lookbackHours` before `now`. A Loop's hours are
 * checked to be a whole number in 1..168 when it is saved, so they are used as stored.
 */
export function loopWindowStart(lookbackHours: number, now: Date): Date {
  return new Date(now.getTime() - lookbackHours * 3_600_000);
}

/**
 * True when the project has a customer trace that started in the window, false
 * when it has none. The window is left open at its end, so a trace that lands
 * between this check and the agent's start still counts.
 */
export async function windowHasTraces(
  projectId: string,
  lookbackHours: number,
  now: Date = new Date(),
): Promise<boolean> {
  const url = new URL(`/api/v1/projects/${encodeURIComponent(projectId)}/traces`, BACKEND_URL);
  url.searchParams.set("limit", "1");
  url.searchParams.set("start_after", loopWindowStart(lookbackHours, now).toISOString());
  const res = await fetch(url.toString(), {
    headers: { "X-Internal-Secret": process.env.INTERNAL_API_SECRET || "" },
    signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`The trace list answered HTTP ${res.status}`);
  const body = (await res.json()) as { data?: unknown };
  if (!Array.isArray(body.data)) throw new Error("The trace list answered without data");
  return body.data.length > 0;
}
