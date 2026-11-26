/**
 * Which follow-up email, if any, is due for one person right now.
 *
 * A pure function of the facts it is handed: it reads no database and sends
 * nothing. The job calls it for each person on every run (every 15 minutes) and
 * sends at most what it answers, so the answer always reflects the person as
 * they are now: someone who has just sent a first trace is no longer nudged to
 * set up, and someone just paused gets nothing.
 *
 * Nothing is queued ahead. An email held back by the frequency limits is tried
 * again on later runs until it expires, and then dropped.
 */

/** The `campaign` values in `email_sends`. */
export type Campaign = "welcome" | FollowUp;

export type FollowUp = "setup_help" | "last_note" | "connect_slack_github" | "first_eval";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** At least this long between any two emails to the same person. */
const MIN_GAP_MS = 48 * HOUR_MS;
/** At most this many emails to a person in any trailing window. Welcome counts. */
const LIMITS = [
  { windowMs: 7 * DAY_MS, max: 2 },
  { windowMs: 30 * DAY_MS, max: 5 },
] as const;

export interface FollowUpFacts {
  now: Date;
  /** Whether this deployment is the cloud service. Self-hosted gets no follow-ups. */
  isCloud: boolean;
  /**
   * When follow-ups started: people who signed up before it are not in the
   * sequence. Null when it is not set, which keeps everyone out.
   */
  lifecycleStartAt: Date | null;
  signedUpAt: Date;
  /** Paused by us (outreach started, or by hand). */
  paused: boolean;
  /** Unsubscribed from product email by the person. */
  unsubscribed: boolean;
  /** Joined only workspaces someone else created; see `isInvitedOnly`. */
  invitedOnly: boolean;
  /** The first trace in any of the person's projects, or null. */
  firstTraceAt: Date | null;
  githubConnected: boolean;
  slackConnected: boolean;
  /** Whether the person has run an evaluation. */
  hasRunEval: boolean;
  /**
   * The product emails already sent (or claimed for sending) to this person,
   * with when. The monthly newsletter is not one of them: it counts toward no
   * limit.
   */
  sends: readonly { campaign: Campaign; at: Date }[];
}

/** Why nobody is due, for the dry-run log. */
export type NotDueReason =
  | "self_hosted"
  | "before_start"
  | "paused"
  | "unsubscribed"
  | "invited_only"
  | "no_welcome"
  | "frequency_limit"
  | "nothing_due";

export type FollowUpDecision = { send: FollowUp } | { send: null; reason: NotDueReason };

interface Window {
  campaign: FollowUp;
  dueAt: Date;
  /** Not sent at or after this. */
  expiresAt: Date;
}

const after = (from: Date, ms: number) => new Date(from.getTime() + ms);

/** Each follow-up's window, for this person, in the order they fall due. */
function windows(facts: FollowUpFacts): Window[] {
  const { signedUpAt, firstTraceAt } = facts;
  if (!firstTraceAt) {
    // Still no trace: two nudges to set up, then nothing more.
    return [
      {
        campaign: "setup_help",
        dueAt: after(signedUpAt, 3 * DAY_MS),
        expiresAt: after(signedUpAt, 6 * DAY_MS),
      },
      {
        campaign: "last_note",
        dueAt: after(signedUpAt, 7 * DAY_MS),
        expiresAt: after(signedUpAt, 10 * DAY_MS),
      },
    ];
  }
  const windowsAfterTrace: Window[] = [];
  // Only one of GitHub and Slack connected still gets it; both does not.
  if (!(facts.githubConnected && facts.slackConnected)) {
    const dueAt = after(firstTraceAt, 7 * DAY_MS);
    windowsAfterTrace.push({
      campaign: "connect_slack_github",
      dueAt,
      expiresAt: after(dueAt, 7 * DAY_MS),
    });
  }
  if (!facts.hasRunEval) {
    const dueAt = after(firstTraceAt, 14 * DAY_MS);
    windowsAfterTrace.push({ campaign: "first_eval", dueAt, expiresAt: after(dueAt, 7 * DAY_MS) });
  }
  return windowsAfterTrace;
}

/** Whether one more email now would break a frequency limit. */
function overLimit(facts: FollowUpFacts): boolean {
  const now = facts.now.getTime();
  const ago = facts.sends.map((send) => now - send.at.getTime());
  if (ago.some((ms) => ms < MIN_GAP_MS)) return true;
  // A send exactly a window ago has left it.
  return LIMITS.some(({ windowMs, max }) => ago.filter((ms) => ms < windowMs).length >= max);
}

export function decideFollowUp(facts: FollowUpFacts): FollowUpDecision {
  if (!facts.isCloud) return { send: null, reason: "self_hosted" };
  if (!facts.lifecycleStartAt || facts.signedUpAt < facts.lifecycleStartAt)
    return { send: null, reason: "before_start" };
  if (facts.unsubscribed) return { send: null, reason: "unsubscribed" };
  if (facts.paused) return { send: null, reason: "paused" };
  if (facts.invitedOnly) return { send: null, reason: "invited_only" };
  // The follow-ups continue the welcome email; nobody gets one without it.
  if (!facts.sends.some((send) => send.campaign === "welcome"))
    return { send: null, reason: "no_welcome" };

  const sent = new Set(facts.sends.map((send) => send.campaign));
  const due = windows(facts).find(
    (w) => !sent.has(w.campaign) && w.dueAt <= facts.now && facts.now < w.expiresAt,
  );
  if (!due) return { send: null, reason: "nothing_due" };
  if (overLimit(facts)) return { send: null, reason: "frequency_limit" };
  return { send: due.campaign };
}

/**
 * Whether someone only joined workspaces that others created: a member of at
 * least one workspace other than the demo, and the creator of none. Pending
 * invites cannot answer this, because an accepted invite's row is deleted.
 *
 * The demo workspace is left out, since everyone is a member of it. Someone in
 * no workspace at all is not invited-only: they signed up and did not finish
 * setting up, which is who the setup emails are for.
 */
export function isInvitedOnly(
  userId: string,
  workspaces: readonly { isDemo: boolean; createdBy: string | null }[],
): boolean {
  const own = workspaces.filter((workspace) => !workspace.isDemo);
  return own.length > 0 && own.every((workspace) => workspace.createdBy !== userId);
}
