import { prisma, type PrismaClient } from "@traceroot/core";
import { lockSignalPartition } from "@traceroot/core/signals";
import { resolveRecipients } from "../../notifications/digest-recipients.js";
import { alertWindowMs, getDigestQueue } from "../../notifications/digest-schedule.js";
import { sendEmail } from "../../notifications/email.js";
import { postSlackMessage } from "../../notifications/slack.js";
import {
  buildSignalDigestBlocks,
  buildSignalDigestEmail,
  digestHeadline,
} from "./digest-render.js";
import { signalsAvailable } from "./config.js";

/** The project's notification window in ms (its alert window setting). */
async function projectWindowMs(
  db: Pick<PrismaClient, "detectorAlertConfig">,
  projectId: string,
): Promise<number> {
  const config = await db.detectorAlertConfig.findUnique({
    where: { projectId },
    select: { alertWindow: true },
  });
  return alertWindowMs(config?.alertWindow);
}

/**
 * Enqueue the project's signal digest, by default to send one notification
 * window (the project's alert window) after this change. One job per project;
 * while one is waiting, later enqueues are no-ops, so the changes of a window
 * share a digest.
 */
export async function enqueueSignalDigest(projectId: string, delayMs?: number): Promise<void> {
  const delay = delayMs ?? (await projectWindowMs(prisma, projectId));
  await getDigestQueue().add(
    `signal-digest-${projectId}`,
    { kind: "signals", projectId },
    {
      jobId: `signal-digest-${projectId}`,
      delay,
      removeOnComplete: true,
      removeOnFail: true,
    },
  );
}

/** A signal with something the digest has not reported yet. */
export interface PendingSignal {
  id: string;
  title: string;
  detectorId: string;
  status: string;
  hitCount: number;
  reopenSeq: number;
  notifiedReopenSeq: number | null;
  notifiedHitCount: number;
  mergedIntoId: string | null;
  /** Exact unreported hits visible in the same snapshot as the counts. */
  runIds: string[];
}

/** The RCA of one opening of a signal. */
export interface OpeningRca {
  reopenSeq: number;
  /** The finding's latest attempt (detector_rcas.status). */
  status: string;
  /** Whether a successful answer is kept on this opening. */
  answered: boolean;
  /** The root cause the kept answer gave for this opening's hit. */
  rootCause: string | null;
}

export interface DigestItem {
  signalId: string;
  title: string;
  detectorId: string;
  detectorName: string;
  kind: "new" | "reopened";
  hitCount: number;
  /** What the RCA has found by the time the digest is sent, if it ran. */
  rca: { state: "done" | "failed" | "running"; rootCause: string | null } | null;
}

export interface DigestPlan {
  /** What to send now; empty means send nothing. */
  items: DigestItem[];
  /** Signals whose state is recorded as reported: the sent ones and the silently counted ones. */
  consumed: { id: string; reopenSeq: number; hitCount: number; sent: boolean; runIds: string[] }[];
}

/**
 * Decide the project's next signal digest. New and reopened signals are
 * announced once each, with whatever their RCA has found by then: the digest
 * never waits for an RCA, and an RCA finishing later sends nothing. Further
 * hits on an announced signal are counted silently, as are dismissed, resolved
 * and merged signals and detectors no longer grouping.
 */
export function planSignalDigest(input: {
  signals: readonly PendingSignal[];
  /** Detectors in signals mode (switch on and signals available), by id → name. */
  groupingDetectors: ReadonlyMap<string, string>;
  /** Each signal's RCAs, by signal id. */
  rcas: ReadonlyMap<string, readonly OpeningRca[]>;
}): DigestPlan {
  const items: DigestItem[] = [];
  const silent: PendingSignal[] = [];

  for (const s of input.signals) {
    const detectorName = input.groupingDetectors.get(s.detectorId);
    const unannounced = s.notifiedReopenSeq === null || s.notifiedReopenSeq < s.reopenSeq;
    if (s.mergedIntoId || detectorName === undefined || s.status !== "open" || !unannounced) {
      silent.push(s);
      continue;
    }
    // The newest RCA of any opening since the last announcement: a reopening
    // inside the RCA cooldown has none of its own, while an earlier opening's
    // RCA may still be running or have finished.
    const since = s.notifiedReopenSeq ?? -1;
    const available = (input.rcas.get(s.id) ?? []).filter((r) => r.reopenSeq <= s.reopenSeq);
    const newest = (rows: OpeningRca[]) => rows.sort((a, b) => b.reopenSeq - a.reopenSeq)[0];
    const rca =
      newest(available.filter((r) => r.reopenSeq > since)) ??
      // No new analysis inside the cooldown: display the kept canonical answer.
      newest(available.filter((r) => r.answered));
    items.push({
      signalId: s.id,
      title: s.title,
      detectorId: s.detectorId,
      detectorName,
      hitCount: s.hitCount,
      kind: s.notifiedReopenSeq === null ? "new" : "reopened",
      rca: !rca
        ? null
        : rca.answered
          ? { state: "done", rootCause: rca.rootCause }
          : { state: rca.status === "failed" ? "failed" : "running", rootCause: null },
    });
  }

  const byId = new Map(input.signals.map((s) => [s.id, s]));
  const consumed = [
    ...items.map((i) => {
      const s = byId.get(i.signalId)!;
      return {
        id: s.id,
        reopenSeq: s.reopenSeq,
        hitCount: s.hitCount,
        sent: true,
        runIds: s.runIds,
      };
    }),
    ...silent.map((s) => ({
      id: s.id,
      reopenSeq: s.reopenSeq,
      hitCount: s.hitCount,
      sent: false,
      runIds: s.runIds,
    })),
  ];
  return { items, consumed };
}

type DigestDb = Pick<
  PrismaClient,
  | "$queryRaw"
  | "$executeRaw"
  | "$transaction"
  | "detector"
  | "signalRca"
  | "signal"
  | "signalHit"
  | "detectorAlertConfig"
>;

/** Read the project's signals with unreported changes and what the plan needs. */
export async function loadDigestInput(db: DigestDb, projectId: string) {
  const signals = await db.$queryRaw<PendingSignal[]>`
    SELECT id, title, detector_id AS "detectorId", status, hit_count AS "hitCount",
           reopen_seq AS "reopenSeq", notified_reopen_seq AS "notifiedReopenSeq",
           notified_hit_count AS "notifiedHitCount", merged_into_id AS "mergedIntoId",
           ARRAY(SELECT h.run_id FROM signal_hits h
                 WHERE h.signal_id = signals.id AND h.reported_at IS NULL) AS "runIds"
    FROM signals
    WHERE project_id = ${projectId}
      AND (notified_reopen_seq IS DISTINCT FROM reopen_seq OR hit_count <> notified_hit_count)
    ORDER BY create_time
    LIMIT 1000`;
  const detectors = await db.detector.findMany({
    where: { id: { in: [...new Set(signals.map((s) => s.detectorId))] } },
    select: { id: true, name: true, enableSignals: true },
  });
  const grouping = signalsAvailable();
  const groupingDetectors = new Map(
    detectors.filter((d) => d.enableSignals && grouping).map((d) => [d.id, d.name]),
  );
  const rcaRows = await db.signalRca.findMany({
    where: { signalId: { in: signals.map((s) => s.id) } },
    select: {
      signalId: true,
      reopenSeq: true,
      result: true,
      rootCause: true,
      rca: { select: { status: true } },
    },
  });
  const rcas = new Map<string, OpeningRca[]>();
  for (const r of rcaRows) {
    const list = rcas.get(r.signalId) ?? [];
    list.push({
      reopenSeq: r.reopenSeq,
      status: r.rca.status,
      answered: r.result !== null,
      rootCause: r.rootCause,
    });
    rcas.set(r.signalId, list);
  }
  return { signals, groupingDetectors, rcas };
}

/**
 * Consume the exact hit snapshot, even if those hits moved while sending.
 * The partition lock serialises marking/recounting with moves and merges;
 * hits that arrived after the snapshot remain unreported.
 */
export async function recordDigest(db: DigestDb, plan: DigestPlan, sentAt: Date): Promise<void> {
  if (plan.consumed.length === 0) return;
  const ids = plan.consumed.map((c) => c.id);
  await db.$transaction(async (tx) => {
    const signals = await tx.signal.findMany({
      where: { id: { in: ids } },
      select: { projectId: true, detectorId: true },
    });
    const partitions = [
      ...new Map(signals.map((s) => [`${s.projectId}:${s.detectorId}`, s] as const)).entries(),
    ].sort(([a], [b]) => a.localeCompare(b));
    for (const [, s] of partitions) await lockSignalPartition(tx, s.projectId, s.detectorId);
    const runIds = [...new Set(plan.consumed.flatMap((c) => c.runIds))];
    // Array parameters keep a large backlog below Postgres's bind-parameter
    // limit; return distinct current owners rather than every hit again.
    const owners = await tx.$queryRaw<{ signalId: string }[]>`
      SELECT DISTINCT signal_id AS "signalId" FROM signal_hits WHERE run_id = ANY(${runIds})`;
    await tx.$executeRaw`
      UPDATE signal_hits SET reported_at = ${sentAt}
      WHERE run_id = ANY(${runIds}) AND reported_at IS NULL`;
    for (const c of plan.consumed) {
      await tx.$executeRaw`
        UPDATE signals
        SET notified_reopen_seq = GREATEST(COALESCE(notified_reopen_seq, -1), ${c.reopenSeq}),
            notified_at = CASE WHEN ${c.sent} THEN GREATEST(notified_at, ${sentAt}) ELSE notified_at END
        WHERE id = ${c.id}`;
    }
    const affected = [...new Set([...ids, ...owners.map((h) => h.signalId)])];
    await tx.$executeRaw`
      UPDATE signals SET notified_hit_count = (
        SELECT count(*) FROM signal_hits h WHERE h.signal_id = signals.id AND h.reported_at IS NOT NULL
      ) WHERE id = ANY(${affected})`;
  });
}

/**
 * Enqueue the digest of projects with unreported signal changes older than the
 * project's notification window, whose digest job was lost or failed to send.
 */
export async function sweepSignalDigests(
  db: Pick<PrismaClient, "$queryRaw">,
  now: number = Date.now(),
): Promise<number> {
  const rows = await db.$queryRaw<
    { projectId: string; oldest: Date; alertWindow: string | null }[]
  >`
    SELECT s.project_id AS "projectId", min(s.update_time) AS oldest,
           max(c.alert_window) AS "alertWindow"
    FROM signals s
    LEFT JOIN detector_alert_configs c ON c.project_id = s.project_id
    WHERE (s.notified_reopen_seq IS DISTINCT FROM s.reopen_seq
           OR s.hit_count <> s.notified_hit_count)
    GROUP BY s.project_id
    ORDER BY oldest
    LIMIT 500`;
  const due = rows.filter((r) => now - r.oldest.getTime() >= alertWindowMs(r.alertWindow));
  for (const r of due) await enqueueSignalDigest(r.projectId, 0);
  return due.length;
}

/**
 * Build and send the project's signal digest, then record what it reported.
 * A project with no alert channels still records its changes as reported, so
 * configuring a channel later does not flood it with old announcements. When
 * every send fails, nothing is recorded and the sweeper sends the digest again.
 */
export async function flushSignalDigest(
  projectId: string,
  now: number = Date.now(),
  db: DigestDb = prisma,
): Promise<DigestPlan | null> {
  const input = await loadDigestInput(db, projectId);
  if (input.signals.length === 0) return null;
  const plan = planSignalDigest(input);
  if (plan.items.length > 0) {
    const recipients = await resolveRecipients(projectId);
    if (!recipients) {
      console.log(`[Digest] skip signals project=${projectId} reason=no-channels`);
    } else {
      const content = { projectId, projectName: recipients.projectName, items: plan.items };
      const sends: { channel: string; send: Promise<boolean> }[] = [];
      if (recipients.slackChannelId && recipients.encryptedBotToken) {
        sends.push({
          channel: "Slack",
          send: postSlackMessage({
            workspaceId: recipients.workspaceId,
            encryptedBotToken: recipients.encryptedBotToken,
            channelId: recipients.slackChannelId,
            blocks: buildSignalDigestBlocks(content),
            text: digestHeadline(plan.items, recipients.projectName),
          }),
        });
      }
      if (recipients.emailAddresses.length > 0) {
        sends.push({
          channel: "email",
          send: sendEmail({ to: recipients.emailAddresses, ...buildSignalDigestEmail(content) }),
        });
      }
      const results = await Promise.allSettled(sends.map((s) => s.send));
      results.forEach((r, i) => {
        if (r.status === "rejected") {
          console.error(
            `[Digest] signals ${sends[i].channel} send failed for ${projectId}:`,
            r.reason,
          );
        }
      });
      // Every send failed: leave the changes unreported so the sweeper sends
      // them again. A channel that is not set up (no SMTP, no Slack plan)
      // counts as no channel, like a project without recipients.
      const delivered = results.some((r) => r.status === "fulfilled" && r.value);
      if (!delivered && results.some((r) => r.status === "rejected")) {
        console.log(`[Digest] signals project=${projectId} not sent; retrying later`);
        return plan;
      }
      console.log(
        `[Digest] sent signals project=${projectId} ` +
          SECTION_KINDS.map((k) => `${k}=${plan.items.filter((i) => i.kind === k).length}`).join(
            " ",
          ),
      );
    }
  }
  await recordDigest(db, plan, new Date(now));
  return plan;
}

const SECTION_KINDS = ["new", "reopened", "ongoing"] as const;
