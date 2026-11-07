/**
 * Replays sign-ups to the sign-up webhook (TRACEROOT_SIGNUP_WEBHOOK_URL).
 *
 * "reconcile" (weekly) sends every self-service sign-up the receiver hasn't
 * acknowledged: the web app records users.signup_delivered_at when the live
 * send is accepted, and this records it for each replayed one. Nothing is
 * bounded by a window, so a sign-up missed during a long outage, or one whose
 * replay failed, is sent again by the next run until it is acknowledged.
 * Which accounts count is read from users.signup_method, written with the
 * account: staff-provisioned accounts ("admin") are never sent, and accounts
 * created before the method was recorded (null) are never sent automatically.
 *
 * "backfill" (once, by hand) sends an explicitly approved list of user IDs,
 * for accounts from before the live send. Their sign-up method is reported
 * as recorded, or "unknown" when it never was; it isn't inferred from the
 * accounts linked since.
 *
 * Every event of a run carries its run ID, and the run ends with a summary
 * listing every user it covered. The ID is stable for the same run (a weekly
 * run's date, a backfill's list), so a retried or overlapping run is reported
 * as one. The receiver keeps one record per user ID, so a repeat is counted
 * as already received, never handled twice.
 */
import { createHash } from "node:crypto";
import { prisma } from "@traceroot/core";
import {
  buildSignupsReplayedEvent,
  buildSignupWebhookEvent,
  sendSignupWebhook,
  type SignupWebhookConfig,
} from "@traceroot/core/signup-webhook";

const HOUR = 60 * 60 * 1000;
const PAGE = 500;

export interface ReplayOptions {
  config: SignupWebhookConfig;
  // false: count what would be sent, send nothing.
  send: boolean;
  fetchImpl?: typeof fetch;
  log?: (line: string) => void;
}

export interface ReplayResult {
  runId: string;
  // Users the run covered: every unacknowledged sign-up, or every listed user
  // that could be sent.
  eligible: number;
  // Already acknowledged, so not sent again (backfill only).
  alreadyDelivered: number;
  sent: number;
  failed: number;
  // Listed for a backfill but provisioned by staff, or not found.
  excluded: number;
  notFound: number;
  // Whether the closing summary reached the receiver.
  summarySent: boolean;
  byProvider: Record<string, number>;
}

interface ReplayUser {
  id: string;
  email: string;
  name: string | null;
  createdAt: Date;
  signupMethod: string | null;
  signupDeliveredAt: Date | null;
}

const userFields = {
  id: true,
  email: true,
  name: true,
  createdAt: true,
  signupMethod: true,
  signupDeliveredAt: true,
} as const;

export function signupWebhookConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): SignupWebhookConfig {
  return { url: env.TRACEROOT_SIGNUP_WEBHOOK_URL, secret: env.TRACEROOT_SIGNUP_WEBHOOK_SECRET };
}

// One run per UTC day: a rerun, or a second worker, the same day is the same run.
export function reconcileRunId(now: Date): string {
  return `reconcile-${now.toISOString().slice(0, 10)}`;
}

// The same approved list is the same run, however often it is resumed.
export function backfillRunId(userIds: readonly string[]): string {
  const digest = createHash("sha256")
    .update([...new Set(userIds)].sort().join("\n"))
    .digest("hex");
  return `backfill-${digest.slice(0, 16)}`;
}

// Sign-ups never acknowledged, from an hour ago and earlier so a live send
// still in flight isn't replayed. Paged by ID rather than a cursor, because
// sending a page takes its users out of the filter.
async function* unacknowledgedSignups(before: Date): AsyncGenerator<ReplayUser> {
  let after = "";
  for (;;) {
    const users: ReplayUser[] = await prisma.user.findMany({
      where: {
        AND: [{ signupMethod: { not: null } }, { signupMethod: { not: "admin" } }],
        signupDeliveredAt: null,
        createdAt: { lt: before },
        id: { gt: after },
      },
      orderBy: { id: "asc" },
      take: PAGE,
      select: userFields,
    });
    yield* users;
    if (users.length < PAGE) return;
    after = users[users.length - 1]!.id;
  }
}

async function* listedUsers(userIds: readonly string[]): AsyncGenerator<ReplayUser | string> {
  for (let i = 0; i < userIds.length; i += PAGE) {
    const ids = userIds.slice(i, i + PAGE);
    const found: ReplayUser[] = await prisma.user.findMany({
      where: { id: { in: ids } },
      select: userFields,
    });
    const byId = new Map(found.map((user) => [user.id, user]));
    // A missing ID is yielded as itself.
    for (const id of ids) yield byId.get(id) ?? id;
  }
}

// A backfill list: one user ID per line, blank lines and #-comments ignored.
export function parseUserIds(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.replace(/#.*/, "").trim())
    .filter(Boolean);
}

// Accounts created before the sign-up method was recorded: never replayed
// automatically, only from an approved backfill list.
export function countUnrecordedAccounts(): Promise<number> {
  return prisma.user.count({ where: { signupMethod: null } });
}

async function replay(
  delivery: "backfill" | "reconcile",
  runId: string,
  users: AsyncIterable<ReplayUser | string>,
  options: ReplayOptions,
): Promise<ReplayResult> {
  const log = options.log ?? ((line: string) => console.log(line));
  const startedAt = new Date();
  const result: ReplayResult = {
    runId,
    eligible: 0,
    alreadyDelivered: 0,
    sent: 0,
    failed: 0,
    excluded: 0,
    notFound: 0,
    summarySent: false,
    byProvider: {},
  };
  const userIds: string[] = [];

  for await (const user of users) {
    if (typeof user === "string") {
      result.notFound += 1;
      continue;
    }
    if (user.signupMethod === "admin") {
      result.excluded += 1;
      continue;
    }
    result.eligible += 1;
    userIds.push(user.id);
    const provider = user.signupMethod ?? "unknown";
    result.byProvider[provider] = (result.byProvider[provider] ?? 0) + 1;
    if (user.signupDeliveredAt) {
      result.alreadyDelivered += 1;
      continue;
    }
    if (!options.send) continue;
    try {
      const delivered = await sendSignupWebhook(
        buildSignupWebhookEvent({
          user: { id: user.id, email: user.email, name: user.name, createdAt: user.createdAt },
          provider,
          // Accepting an invite deletes it, so a replay can't say.
          viaInvite: null,
          delivery,
          runId,
        }),
        options.config,
        { fetchImpl: options.fetchImpl, timeoutMs: 10_000 },
      );
      if (!delivered) throw new Error("the sign-up webhook isn't configured");
      result.sent += 1;
    } catch (error) {
      result.failed += 1;
      log(
        `[Signup replay] Sending user ${user.id} failed: ${error instanceof Error ? error.message : error}`,
      );
      continue;
    }
    // Sent but not recorded: the next run sends it again, and the receiver
    // counts the repeat as already received.
    try {
      await prisma.user.updateMany({
        where: { id: user.id, signupDeliveredAt: null },
        data: { signupDeliveredAt: new Date() },
      });
    } catch (error) {
      log(
        `[Signup replay] Recording user ${user.id} as delivered failed: ${error instanceof Error ? error.message : error}`,
      );
    }
  }

  // Sent even when some sign-ups failed: the receiver reports them as missing.
  // A failure here is logged, not thrown, so the counts above still reach the
  // caller.
  if (options.send) {
    try {
      result.summarySent = await sendSignupWebhook(
        buildSignupsReplayedEvent({ delivery, runId, startedAt, userIds }),
        options.config,
        { fetchImpl: options.fetchImpl, timeoutMs: 30_000 },
      );
    } catch (error) {
      log(
        `[Signup replay] Sending the summary failed: ${error instanceof Error ? error.message : error}`,
      );
    }
  }
  return result;
}

export function reconcileSignups(options: ReplayOptions & { now?: Date }): Promise<ReplayResult> {
  const now = options.now ?? new Date();
  return replay(
    "reconcile",
    reconcileRunId(now),
    unacknowledgedSignups(new Date(now.getTime() - HOUR)),
    options,
  );
}

export function backfillSignups(
  options: ReplayOptions & { userIds: readonly string[] },
): Promise<ReplayResult> {
  const userIds = [...new Set(options.userIds)];
  return replay("backfill", backfillRunId(userIds), listedUsers(userIds), options);
}
