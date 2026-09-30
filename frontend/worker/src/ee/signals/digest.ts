import { prisma, type PrismaClient } from "@traceroot/core";
import { resolveRecipients } from "../../notifications/digest-recipients.js";
import { getDigestQueue } from "../../notifications/digest-schedule.js";
import { sendEmail } from "../../notifications/email.js";
import { postSlackMessage } from "../../notifications/slack.js";
import {
  buildSignalDigestBlocks,
  buildSignalDigestEmail,
  digestHeadline,
} from "./digest-render.js";
import {
  DIGEST_RCA_WAIT_MS,
  DIGEST_SWEEP_STALE_MS,
  ONGOING_DIGEST_INTERVAL_MS,
  SIGNAL_DIGEST_DELAY_MS,
  signalsAvailable,
} from "./config.js";

/**
 * Enqueue the project's signal digest. One job per project; while one is
 * waiting, later enqueues are no-ops, so changes close together share a digest.
 */
export async function enqueueSignalDigest(
  projectId: string,
  delayMs: number = SIGNAL_DIGEST_DELAY_MS,
): Promise<void> {
  await getDigestQueue().add(
    `signal-digest-${projectId}`,
    { kind: "signals", projectId },
    {
      jobId: `signal-digest-${projectId}`,
      delay: delayMs,
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
}

/** The RCA of one opening of a signal (signal_rcas joined to detector_rcas). */
export interface OpeningRca {
  reopenSeq: number;
  status: string;
  result: string | null;
  createTime: Date;
}

export interface DigestItem {
  signalId: string;
  title: string;
  detectorId: string;
  detectorName: string;
  kind: "new" | "reopened" | "ongoing";
  hitCount: number;
  /** Hits since the last digest that reported this signal. */
  newHits: number;
  /** For new and reopened signals: what the RCA found, if it ran. */
  rca: { state: "done" | "failed" | "running"; rootCause: string | null } | null;
}

export interface DigestPlan {
  /** What to send now; empty means send nothing. */
  items: DigestItem[];
  /** Signals whose state is recorded as reported: the sent ones and the silently counted ones. */
  consumed: { id: string; reopenSeq: number; hitCount: number; sent: boolean }[];
}

/**
 * The root cause an RCA gave for one detector's hit: the "Root cause:" line of
 * the section that names the detector, or the first one in the text.
 */
export function rootCauseLine(result: string, detectorName: string): string | null {
  const sections = result.split(/\n(?=#{2,4}\s)/);
  const name = detectorName.toLowerCase();
  const section = sections.find((s) => s.split("\n")[0].toLowerCase().includes(name)) ?? result;
  const match = section.match(/root cause:\**\s*(.+)/i) ?? result.match(/root cause:\**\s*(.+)/i);
  return match ? match[1].replace(/\*+/g, "").trim() : null;
}

/**
 * Decide the project's next signal digest. New and reopened signals are
 * announced once each, when their RCA has finished or after DIGEST_RCA_WAIT_MS;
 * ongoing signals (open, with new hits) ride along, or go out alone at most
 * every ONGOING_DIGEST_INTERVAL_MS and never while an announcement is waiting
 * for its RCA. Dismissed, resolved and merged signals, and detectors no longer
 * grouping, are counted silently.
 */
export function planSignalDigest(input: {
  signals: readonly PendingSignal[];
  /** Detectors in signals mode (switch on and signals available), by id → name. */
  groupingDetectors: ReadonlyMap<string, string>;
  /** Each signal's RCAs, by signal id. */
  rcas: ReadonlyMap<string, readonly OpeningRca[]>;
  lastSentAt: number | null;
  now: number;
}): DigestPlan {
  const { now } = input;
  const announce: DigestItem[] = [];
  const ongoing: DigestItem[] = [];
  const silent: PendingSignal[] = [];
  let held = 0;

  for (const s of input.signals) {
    const detectorName = input.groupingDetectors.get(s.detectorId);
    if (s.mergedIntoId || detectorName === undefined || s.status !== "open") {
      silent.push(s);
      continue;
    }
    const base = {
      signalId: s.id,
      title: s.title,
      detectorId: s.detectorId,
      detectorName,
      hitCount: s.hitCount,
      newHits: Math.max(0, s.hitCount - s.notifiedHitCount),
    };
    const unannounced = s.notifiedReopenSeq === null || s.notifiedReopenSeq < s.reopenSeq;
    if (unannounced) {
      // The newest RCA of any opening since the last announcement: a reopening
      // inside the RCA cooldown has none of its own, while an earlier opening's
      // RCA may still be running or just have finished.
      const since = s.notifiedReopenSeq ?? -1;
      const rca = (input.rcas.get(s.id) ?? [])
        .filter((r) => r.reopenSeq > since && r.reopenSeq <= s.reopenSeq)
        .sort((a, b) => b.reopenSeq - a.reopenSeq)[0];
      const finished = rca && (rca.status === "done" || rca.status === "failed");
      if (rca && !finished && now - rca.createTime.getTime() < DIGEST_RCA_WAIT_MS) {
        held++;
        continue;
      }
      announce.push({
        ...base,
        kind: s.notifiedReopenSeq === null ? "new" : "reopened",
        rca: !rca
          ? null
          : rca.status === "done"
            ? {
                state: "done",
                rootCause: rca.result ? rootCauseLine(rca.result, detectorName) : null,
              }
            : { state: rca.status === "failed" ? "failed" : "running", rootCause: null },
      });
    } else if (s.hitCount > s.notifiedHitCount) {
      ongoing.push({ ...base, kind: "ongoing", rca: null });
    } else {
      silent.push(s);
    }
  }

  const ongoingDue =
    input.lastSentAt === null || now - input.lastSentAt >= ONGOING_DIGEST_INTERVAL_MS;
  const items =
    announce.length > 0
      ? [...announce, ...ongoing]
      : ongoing.length > 0 && held === 0 && ongoingDue
        ? ongoing
        : [];
  const byId = new Map(input.signals.map((s) => [s.id, s]));
  const consumed = [
    ...items.map((i) => {
      const s = byId.get(i.signalId)!;
      return { id: s.id, reopenSeq: s.reopenSeq, hitCount: s.hitCount, sent: true };
    }),
    ...silent.map((s) => ({ id: s.id, reopenSeq: s.reopenSeq, hitCount: s.hitCount, sent: false })),
  ];
  return { items, consumed };
}

type DigestDb = Pick<
  PrismaClient,
  "$queryRaw" | "$transaction" | "detector" | "signalRca" | "signal"
>;

/** Read the project's signals with unreported changes and what the plan needs. */
export async function loadDigestInput(db: DigestDb, projectId: string, now: number) {
  const signals = await db.$queryRaw<PendingSignal[]>`
    SELECT id, title, detector_id AS "detectorId", status, hit_count AS "hitCount",
           reopen_seq AS "reopenSeq", notified_reopen_seq AS "notifiedReopenSeq",
           notified_hit_count AS "notifiedHitCount", merged_into_id AS "mergedIntoId"
    FROM signals
    WHERE project_id = ${projectId}
      AND (notified_reopen_seq IS DISTINCT FROM reopen_seq OR hit_count <> notified_hit_count)
    ORDER BY create_time
    LIMIT 1000`;
  const [last] = await db.$queryRaw<{ lastSentAt: Date | null }[]>`
    SELECT max(notified_at) AS "lastSentAt" FROM signals WHERE project_id = ${projectId}`;
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
      createTime: true,
      rca: { select: { status: true, result: true } },
    },
  });
  const rcas = new Map<string, OpeningRca[]>();
  for (const r of rcaRows) {
    const list = rcas.get(r.signalId) ?? [];
    list.push({
      reopenSeq: r.reopenSeq,
      status: r.rca.status,
      result: r.rca.result,
      createTime: r.createTime,
    });
    rcas.set(r.signalId, list);
  }
  return {
    signals,
    groupingDetectors,
    rcas,
    lastSentAt: last?.lastSentAt ? last.lastSentAt.getTime() : null,
    now,
  };
}

/**
 * Record what the digest reported: the reopen_seq and hit count read, not the
 * current ones, so a hit that landed after the read is reported next time.
 * Only sent signals get notified_at, which rate-limits ongoing-only digests.
 */
export async function recordDigest(db: DigestDb, plan: DigestPlan, sentAt: Date): Promise<void> {
  if (plan.consumed.length === 0) return;
  await db.$transaction(
    plan.consumed.map((c) =>
      db.signal.update({
        where: { id: c.id },
        data: {
          notifiedReopenSeq: c.reopenSeq,
          notifiedHitCount: c.hitCount,
          ...(c.sent ? { notifiedAt: sentAt } : {}),
        },
      }),
    ),
  );
}

/**
 * Enqueue the digest of projects whose signals changed over DIGEST_SWEEP_STALE_MS
 * ago and are still unreported: announcements whose RCA finished while no digest
 * job was queued, ongoing hits waiting out the hourly limit, a lost job.
 */
export async function sweepSignalDigests(
  db: Pick<PrismaClient, "$queryRaw">,
  now: number = Date.now(),
): Promise<number> {
  const rows = await db.$queryRaw<{ projectId: string }[]>`
    SELECT DISTINCT project_id AS "projectId"
    FROM signals
    WHERE (notified_reopen_seq IS DISTINCT FROM reopen_seq OR hit_count <> notified_hit_count)
      AND update_time < ${new Date(now - DIGEST_SWEEP_STALE_MS)}
    LIMIT 500`;
  for (const r of rows) await enqueueSignalDigest(r.projectId, 0);
  return rows.length;
}

/**
 * Build and send the project's signal digest, then record what it reported.
 * A project with no alert channels still records its changes as reported, so
 * configuring a channel later does not flood it with old announcements.
 */
export async function flushSignalDigest(
  projectId: string,
  now: number = Date.now(),
  db: DigestDb = prisma,
): Promise<DigestPlan | null> {
  const input = await loadDigestInput(db, projectId, now);
  if (input.signals.length === 0) return null;
  const plan = planSignalDigest(input);
  if (plan.items.length > 0) {
    const recipients = await resolveRecipients(projectId);
    if (!recipients) {
      console.log(`[Digest] skip signals project=${projectId} reason=no-channels`);
    } else {
      const content = { projectId, projectName: recipients.projectName, items: plan.items };
      const sends: Promise<unknown>[] = [];
      if (recipients.slackChannelId && recipients.encryptedBotToken) {
        sends.push(
          postSlackMessage({
            workspaceId: recipients.workspaceId,
            encryptedBotToken: recipients.encryptedBotToken,
            channelId: recipients.slackChannelId,
            blocks: buildSignalDigestBlocks(content),
            text: digestHeadline(plan.items, recipients.projectName),
          }).catch((e) => console.error(`[Digest] signals Slack send failed for ${projectId}:`, e)),
        );
      }
      if (recipients.emailAddresses.length > 0) {
        sends.push(
          sendEmail({ to: recipients.emailAddresses, ...buildSignalDigestEmail(content) }).catch(
            (e) => console.error(`[Digest] signals email send failed for ${projectId}:`, e),
          ),
        );
      }
      await Promise.allSettled(sends);
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
