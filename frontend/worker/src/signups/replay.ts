/**
 * Replays sign-ups to the sign-up webhook (TRACEROOT_SIGNUP_WEBHOOK_URL): every
 * week for the ones the web app's live send may have missed ("reconcile"), and
 * once for users who signed up before the live send existed ("backfill"). The
 * receiver keeps one record per user ID, so a sign-up it already has is only
 * counted, never handled twice. Each replay ends with a summary listing every
 * sign-up it covered, so the receiver can report how many it already had and
 * how many the replay recovered.
 *
 * Nothing records how an account was created, so every user created in the
 * window is replayed; the receiver skips team and test accounts.
 */
import { prisma } from "@traceroot/core";
import {
  buildSignupsReplayedEvent,
  buildSignupWebhookEvent,
  sendSignupWebhook,
  type SignupWebhookConfig,
} from "@traceroot/core/signup-webhook";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const PAGE = 500;

export interface ReplayOptions {
  delivery: "backfill" | "reconcile";
  from: Date;
  to: Date;
  config: SignupWebhookConfig;
  // false: count what would be sent, send nothing.
  send: boolean;
  fetchImpl?: typeof fetch;
  log?: (line: string) => void;
}

export interface ReplayResult {
  eligible: number;
  sent: number;
  failed: number;
  invited: number;
  byProvider: Record<string, number>;
}

export function signupWebhookConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): SignupWebhookConfig {
  return { url: env.TRACEROOT_SIGNUP_WEBHOOK_URL, secret: env.TRACEROOT_SIGNUP_WEBHOOK_SECRET };
}

// better-auth stores email sign-ups as the "credential" provider; the live
// hook reports those as "email".
export function providerOf(providerId: string | undefined): string {
  if (!providerId) return "unknown";
  return providerId === "credential" ? "email" : providerId.toLowerCase();
}

async function* signupsBetween(from: Date, to: Date) {
  let cursor: string | undefined;
  for (;;) {
    const users = await prisma.user.findMany({
      where: { createdAt: { gte: from, lt: to } },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: PAGE,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      select: {
        id: true,
        email: true,
        name: true,
        createdAt: true,
        // The account the user signed up with.
        accounts: { select: { providerId: true }, orderBy: { createdAt: "asc" }, take: 1 },
      },
    });
    yield* users;
    if (users.length < PAGE) return;
    cursor = users[users.length - 1]!.id;
  }
}

export async function replaySignups(options: ReplayOptions): Promise<ReplayResult> {
  const log = options.log ?? ((line: string) => console.log(line));
  const startedAt = new Date();
  const result: ReplayResult = { eligible: 0, sent: 0, failed: 0, invited: 0, byProvider: {} };
  const userIds: string[] = [];

  for await (const user of signupsBetween(options.from, options.to)) {
    result.eligible += 1;
    userIds.push(user.id);
    const provider = providerOf(user.accounts[0]?.providerId);
    result.byProvider[provider] = (result.byProvider[provider] ?? 0) + 1;
    const invite = await prisma.invite.findFirst({
      where: { email: { equals: user.email, mode: "insensitive" } },
      select: { id: true },
    });
    if (invite) result.invited += 1;
    if (!options.send) continue;
    try {
      await sendSignupWebhook(
        buildSignupWebhookEvent({
          user: { id: user.id, email: user.email, name: user.name, createdAt: user.createdAt },
          provider,
          viaInvite: invite != null,
          delivery: options.delivery,
        }),
        options.config,
        { fetchImpl: options.fetchImpl, timeoutMs: 10_000 },
      );
      result.sent += 1;
    } catch (error) {
      result.failed += 1;
      log(
        `[Signup replay] Sending user ${user.id} failed: ${error instanceof Error ? error.message : error}`,
      );
    }
  }

  // Sent even when some sign-ups failed: the receiver reports them as missing.
  if (options.send) {
    await sendSignupWebhook(
      buildSignupsReplayedEvent({
        delivery: options.delivery,
        startedAt,
        from: options.from,
        to: options.to,
        userIds,
      }),
      options.config,
      { fetchImpl: options.fetchImpl, timeoutMs: 30_000 },
    );
  }
  return result;
}

// The weekly window ends an hour ago, so a sign-up whose live send is still in
// flight isn't counted as recovered. Two weeks long, so one failed run doesn't
// leave a gap.
export function reconcileWindow(now: Date, days: number): { from: Date; to: Date } {
  const to = new Date(now.getTime() - HOUR);
  return { from: new Date(to.getTime() - days * DAY), to };
}

export async function reconcileRecentSignups(
  now: Date = new Date(),
  days: number = Number(process.env.SIGNUP_RECONCILE_DAYS) || 14,
): Promise<ReplayResult> {
  return replaySignups({
    delivery: "reconcile",
    ...reconcileWindow(now, days),
    config: signupWebhookConfigFromEnv(),
    send: true,
  });
}
