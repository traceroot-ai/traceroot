/**
 * Durable identity and startup reconciliation for Docker sandbox containers.
 *
 * Ownership of a sandbox used to live only in the agent's in-memory
 * `sessionExecutors` map (`src/index.ts`). Any exit that was not a fully
 * completed graceful shutdown — crash, OOM kill, `docker compose kill`,
 * SIGKILL after the 10s stop grace, or a dev reload that orphaned the map —
 * leaked every container the process owned, and the next process had no way
 * to find them: containers were created with only
 * `--name traceroot-sandbox-<ms>` and no label (`executors/docker.ts`).
 *
 * New containers carry well-defined Docker labels so they can be located
 * without in-memory state:
 *
 * - `traceroot.sandbox=true` — marks application-owned sandboxes.
 * - `traceroot.session=<session-id>` — the owning agent session, when known.
 * - `traceroot.owner=<instance-id>` — the agent process that created it.
 *
 * Label values are validated before use and passed as separate Docker CLI
 * arguments (never through a shell), so a hostile session id cannot inject.
 *
 * Startup reconciliation (`reconcileStaleSandboxes`) removes labeled
 * containers that no active session needs. It runs once, after the new
 * process owns the HTTP port, when its executor map is still empty — so
 * nothing it deletes can belong to a live run in this process. Containers
 * predating labels (name-only `traceroot-sandbox-*`) are reclaimed the same
 * way, gated on the inspected name starting with the exact prefix (Docker's
 * `name=` filter is a substring match, so anything else fails closed);
 * without that pass the leak this module fixes would survive its own
 * deploy.
 *
 * Singleton assumption: the agent is a single replica per Docker daemon. The
 * compose stack declares one `agent` service sharing the host's daemon via
 * `/var/run/docker.sock`, and the launcher refuses to start a second agent
 * while port 8100 is bound — the second process fails to bind and, because
 * reconciliation runs only after a successful listen, never deletes the
 * live owner's containers. Deployments that share one daemon between several
 * concurrent agents are not supported by this cleanup.
 *
 * Deliberately out of scope: idle TTL and per-run teardown. Sessions persist
 * across turns and reuse their sandbox (workspace state survives follow-ups),
 * `AISession.updateTime` is not advanced by new messages and `status` never
 * leaves `"active"`, so there is no reliable idle signal without a migration.
 * A creation-time TTL would kill sandboxes follow-ups still need. Daytona
 * already reaps its own sandboxes (`ephemeral`, `autoStopInterval`); Docker
 * has no equivalent, so restart/shutdown/failed-init cleanup is the safe
 * subset this change implements.
 */

import { execFile } from "child_process";
import { randomUUID } from "crypto";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

/** Marks every sandbox container this application owns. */
export const SANDBOX_LABEL = "traceroot.sandbox";
/** The agent session that owns the container. */
export const SESSION_LABEL = "traceroot.session";
/** The agent process instance that created the container. */
export const OWNER_LABEL = "traceroot.owner";

/** Name prefix for sandbox containers (current and legacy, pre-label). */
export const SANDBOX_NAME_PREFIX = "traceroot-sandbox-";

/** Per-call timeout for the read-only / removal Docker invocations. */
const DOCKER_TIMEOUT_MS = 15_000;

/** Docker label values may only carry this alphabet (cuid session ids and UUID owners do). */
const SAFE_LABEL_VALUE = /^[A-Za-z0-9_.-]{1,128}$/;

export function isSafeLabelValue(value: string): boolean {
  return SAFE_LABEL_VALUE.test(value);
}

const INSTANCE_SLOT = "__tracerootAgentInstanceId";

/**
 * The unique id of this agent process. Pinned on `globalThis` so dev reloads
 * (`vite-node --watch` re-executes the entry in the same process) keep one
 * owner across generations instead of minting a new one per edit.
 */
export function agentInstanceId(): string {
  const carrier = globalThis as typeof globalThis & { [INSTANCE_SLOT]?: string };
  return (carrier[INSTANCE_SLOT] ??= randomUUID());
}

/** A fresh, collision-resistant sandbox name (the old `Date.now()`-only name could collide). */
export function sandboxContainerName(): string {
  return `${SANDBOX_NAME_PREFIX}${Date.now()}-${randomUUID().slice(0, 8)}`;
}

/**
 * `--label` arguments for `docker run`. The session label is omitted when the
 * session id is missing or fails validation — the container is still owned
 * (sandbox + owner labels) rather than refused.
 */
export function sandboxRunLabelArgs(sessionId?: string, ownerId?: string): string[] {
  const owner = ownerId !== undefined && ownerId !== "" ? ownerId : agentInstanceId();
  const args = ["--label", `${SANDBOX_LABEL}=true`, "--label", `${OWNER_LABEL}=${owner}`];
  if (sessionId !== undefined && sessionId !== "" && isSafeLabelValue(sessionId)) {
    args.push("--label", `${SESSION_LABEL}=${sessionId}`);
  }
  return args;
}

/** Container ids with the sandbox label (both running and stopped). */
export async function listLabeledSandboxIds(): Promise<string[]> {
  const { stdout } = await execFileAsync(
    "docker",
    ["ps", "-aq", "--filter", `label=${SANDBOX_LABEL}=true`],
    { timeout: DOCKER_TIMEOUT_MS },
  );
  return stdout
    .split(/\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Container ids whose name matches the sandbox prefix (catches pre-label legacy containers). */
export async function listSandboxIdsByName(): Promise<string[]> {
  const { stdout } = await execFileAsync(
    "docker",
    ["ps", "-aq", "--filter", `name=${SANDBOX_NAME_PREFIX}`],
    { timeout: DOCKER_TIMEOUT_MS },
  );
  return stdout
    .split(/\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export interface ContainerLabels {
  id: string;
  /** The container name as `docker inspect` reports it (leading slash included). */
  name?: string;
  sandbox?: string;
  session?: string;
  owner?: string;
}

/**
 * Whether an inspected container name is genuinely one of ours. Docker's
 * `name=` list filter matches a substring, so `foo-traceroot-sandbox-bar`
 * shows up in the legacy listing — only a name that starts with the exact
 * prefix (after normalizing inspect's leading slash) is eligible. A missing
 * name fails closed: the container is kept.
 */
export function hasLegacySandboxName(name: string | undefined): boolean {
  if (!name) return false;
  const normalized = name.startsWith("/") ? name.slice(1) : name;
  return normalized.startsWith(SANDBOX_NAME_PREFIX);
}

/**
 * Strict `docker inspect`: throws when Docker cannot report, so the legacy
 * pass can fail closed (skip) instead of deleting what it cannot identify.
 */
async function inspectContainersStrict(ids: string[]): Promise<ContainerLabels[]> {
  if (ids.length === 0) return [];
  const { stdout } = await execFileAsync("docker", ["inspect", ...ids], {
    timeout: DOCKER_TIMEOUT_MS,
  });
  const parsed = JSON.parse(stdout) as Array<{
    Id: string;
    Name?: string;
    Config?: { Labels?: Record<string, string> | null };
  }>;
  return parsed.map((entry) => ({
    id: entry.Id,
    name: entry.Name,
    sandbox: entry.Config?.Labels?.[SANDBOX_LABEL],
    session: entry.Config?.Labels?.[SESSION_LABEL],
    owner: entry.Config?.Labels?.[OWNER_LABEL],
  }));
}

/**
 * Read the sandbox labels of the given containers in one `docker inspect`.
 * Containers that vanished between list and inspect are skipped (empty
 * labels) rather than failing the whole pass. Only the label-filtered pass
 * (an exact server-side match) may use this leniency — the legacy
 * name-filtered pass uses the strict inspect above and fails closed.
 */
export async function inspectSandboxLabels(ids: string[]): Promise<ContainerLabels[]> {
  try {
    return await inspectContainersStrict(ids);
  } catch {
    return ids.map((id) => ({ id }));
  }
}

/** Whether a `docker rm` failure means the container is already gone (safe to ignore). */
export function isAlreadyRemoved(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /no such container|no such image|not found/i.test(message);
}

/** Remove one container. Already-absent counts as success; any other failure throws. */
export async function removeSandboxContainer(id: string): Promise<void> {
  try {
    await execFileAsync("docker", ["rm", "-f", id], { timeout: DOCKER_TIMEOUT_MS });
  } catch (error) {
    if (isAlreadyRemoved(error)) return;
    throw error;
  }
}

export interface ReconcileResult {
  removed: string[];
  failed: Array<{ id: string; session?: string; owner?: string; error: unknown }>;
  skippedActive: string[];
}

/**
 * Remove stale application-owned sandboxes. `activeSessionIds` holds the
 * sessions with live executors in this process — at startup it is empty, so
 * every labeled container found belongs to a dead owner and is reclaimed.
 * A container whose session label names an active session is never touched,
 * so a run in flight cannot lose its sandbox to this pass.
 *
 * Never throws: Docker being unavailable must not prevent the agent from
 * serving. Each removal is attempted (concurrently via `allSettled`) even
 * when another fails, and every failure is reported with its labels.
 */
export async function reconcileStaleSandboxes(
  activeSessionIds: ReadonlySet<string> = new Set(),
): Promise<ReconcileResult> {
  const result: ReconcileResult = { removed: [], failed: [], skippedActive: [] };

  let labeled: string[];
  try {
    labeled = await listLabeledSandboxIds();
  } catch (error) {
    console.error("[Agent] Sandbox reconciliation skipped: cannot list containers:", error);
    return result;
  }

  const inspected = await inspectSandboxLabels(labeled);
  // An entry whose session label is unknown (inspect flaked) is only safe to
  // treat as stale at startup, when no session is active. Later callers with
  // a non-empty active set must not delete what they cannot attribute.
  const stale = inspected.filter((entry) =>
    entry.session === undefined
      ? activeSessionIds.size === 0
      : !activeSessionIds.has(entry.session),
  );
  for (const entry of inspected) {
    if (entry.session !== undefined && activeSessionIds.has(entry.session)) {
      result.skippedActive.push(entry.id);
    }
  }

  // Legacy containers predate labels entirely: same name prefix, no sandbox
  // label. They are what this fix inherits from every install that ran
  // before it, so they are reclaimed here rather than left forever. Docker's
  // `name=` filter is a substring match, so every candidate's inspected name
  // must start with the exact prefix — an unrelated container that merely
  // contains it is never touched. An inspect failure skips the whole pass
  // (fail closed) rather than deleting the unidentified.
  let legacyStale: ContainerLabels[] = [];
  try {
    const byName = await listSandboxIdsByName();
    const fresh = byName.filter(
      (id) => !labeled.some((known) => known === id || id.startsWith(known.slice(0, 12))),
    );
    const inspectedLegacy = await inspectContainersStrict(fresh);
    legacyStale = inspectedLegacy.filter(
      (entry) => entry.sandbox === undefined && hasLegacySandboxName(entry.name),
    );
  } catch (error) {
    console.error("[Agent] Sandbox reconciliation skipped legacy pass:", error);
  }

  const targets = [...stale, ...legacyStale];
  const outcomes = await Promise.allSettled(
    targets.map(async (entry) => removeSandboxContainer(entry.id)),
  );
  for (const [index, outcome] of outcomes.entries()) {
    const entry = targets[index];
    if (!entry) continue;
    if (outcome.status === "fulfilled") {
      result.removed.push(entry.id);
    } else {
      result.failed.push({
        id: entry.id,
        session: entry.session,
        owner: entry.owner,
        error: outcome.reason,
      });
    }
  }

  if (result.removed.length > 0 || result.failed.length > 0) {
    console.log(
      `[Agent] Sandbox reconciliation: removed ${result.removed.length}, ` +
        `failed ${result.failed.length}, kept ${result.skippedActive.length} active`,
    );
  }
  for (const failure of result.failed) {
    console.error(
      `[Agent] Failed to remove stale sandbox ${failure.id.slice(0, 12)}` +
        `${failure.session ? ` session=${failure.session}` : ""}` +
        `${failure.owner ? ` owner=${failure.owner}` : ""}:`,
      failure.error,
    );
  }
  return result;
}

export interface DestroyAllResult {
  destroyed: number;
  failed: Array<{ sessionId: string; error: unknown }>;
}

/**
 * Destroy every executor in the map concurrently. One failure never prevents
 * the remaining attempts; entries are untracked before their destroy runs so
 * a throwing teardown cannot leave a dead handle behind for later requests.
 *
 * NOTE: on its own this cannot close the shutdown race — a request that
 * passed an earlier shutdown check can still register an executor after this
 * snapshot. The service (`src/index.ts`) sets its shutdown flag before
 * calling this and refuses late registrations, so nothing lands untracked.
 */
export async function destroyAllExecutors(
  executors: Map<string, { destroy(): Promise<void> }>,
): Promise<DestroyAllResult> {
  const entries = [...executors];
  for (const [sessionId] of entries) executors.delete(sessionId);
  const outcomes = await Promise.allSettled(
    entries.map(async ([, executor]) => executor.destroy()),
  );
  const result: DestroyAllResult = { destroyed: 0, failed: [] };
  for (const [index, outcome] of outcomes.entries()) {
    const entry = entries[index];
    if (!entry) continue;
    if (outcome.status === "fulfilled") {
      result.destroyed += 1;
    } else {
      result.failed.push({ sessionId: entry[0], error: outcome.reason });
    }
  }
  return result;
}

/**
 * Startup readiness gate for sandbox creation.
 *
 * Startup reconciliation scans Docker for stale sandboxes. A request that
 * creates a container mid-scan can land in the listing while the
 * active-session snapshot predates its registration — the scan would then
 * misclassify the live container as stale and delete it. The service closes
 * this gate before reconciling and releases it after (success or failure),
 * and the sandbox-creating route waits on it first. The gate starts open so
 * tests (which never run `main()`) are unaffected, and the health endpoint
 * never waits on it.
 */
export class StartupGate {
  private waiters: Array<() => void> = [];
  private openGate = true;

  /** Block sandbox-creating requests until `release()` runs. */
  close(): void {
    this.openGate = false;
  }

  /** Let waiting (and future) requests through. Idempotent. */
  release(): void {
    if (this.openGate) return;
    this.openGate = true;
    const waiters = this.waiters;
    this.waiters = [];
    for (const wake of waiters) wake();
  }

  isOpen(): boolean {
    return this.openGate;
  }

  /** Resolve once the gate is open — immediately when it already is. */
  wait(): Promise<void> {
    if (this.openGate) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.waiters.push(resolve);
    });
  }
}

/** The process-wide gate the message route waits on during startup. */
export const startupGate = new StartupGate();
