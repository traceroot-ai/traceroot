// One row per (user, campaign) in `email_sends`, so an email is never sent twice however many
// times the code path runs. Order: claim (an insert that wins or loses on the unique index)
// → send (outside any transaction) → stamp. A failed or skipped send releases the claim; a crash
// between claim and stamp leaves the row in-flight until it is deleted by hand.
import { Prisma, type PrismaClient } from "@prisma/client";

export type EmailSendClient = Pick<PrismaClient, "emailSend">;

export type ClaimResult =
  | { status: "claimed"; id: string }
  | { status: "already-sent"; id: string; sentAt: Date }
  | { status: "in-flight" };

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

export async function claimEmailSend(
  db: EmailSendClient,
  params: { userId: string; campaign: string; kind: string; now?: Date },
): Promise<ClaimResult> {
  const now = params.now ?? new Date();
  try {
    const created = await db.emailSend.create({
      data: { userId: params.userId, campaign: params.campaign, kind: params.kind, claimedAt: now },
      select: { id: true },
    });
    return { status: "claimed", id: created.id };
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
  }

  const existing = await db.emailSend.findUnique({
    where: { userId_campaign: { userId: params.userId, campaign: params.campaign } },
    select: { id: true, sentAt: true },
  });
  // Lost the race and the winner already released: in-flight rather than loop; the next attempt claims.
  if (!existing) return { status: "in-flight" };
  if (existing.sentAt) return { status: "already-sent", id: existing.id, sentAt: existing.sentAt };
  return { status: "in-flight" };
}

/** `providerId` is the email provider's message id. Returns false if the row was already stamped. */
export async function stampEmailSend(
  db: EmailSendClient,
  id: string,
  providerId: string | null,
  now: Date = new Date(),
): Promise<boolean> {
  const stamped = await db.emailSend.updateMany({
    where: { id, sentAt: null },
    data: { sentAt: now, providerId },
  });
  return stamped.count === 1;
}

/** Returns false if the row was already stamped, which a release must never undo. */
export async function releaseEmailSend(db: EmailSendClient, id: string): Promise<boolean> {
  const released = await db.emailSend.deleteMany({ where: { id, sentAt: null } });
  return released.count === 1;
}
