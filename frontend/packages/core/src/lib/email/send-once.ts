// Claim → build → send → stamp, written once. Never throws: every outcome is a status.
import {
  sendEmail,
  type EmailKind,
  type OutboundEmail,
  type ResendOptions,
  type SendSkipReason,
} from "./resend.ts";
import {
  claimEmailSend,
  releaseEmailSend,
  stampEmailSend,
  type EmailSendClient,
} from "./send-record.ts";

export type SendOnceResult =
  | { status: "sent"; id: string }
  | { status: "already-sent" }
  | { status: "in-flight" }
  | { status: "skipped"; reason: SendSkipReason }
  | { status: "failed"; error: string };

export async function sendOnce(
  db: EmailSendClient,
  key: { userId: string; campaign: string; kind: EmailKind },
  build: () => OutboundEmail,
  options: ResendOptions = {},
): Promise<SendOnceResult> {
  const tag = `${key.campaign}/${key.userId}`;

  let claim;
  try {
    claim = await claimEmailSend(db, key);
  } catch (error) {
    console.error(`[email] ${tag}: claim failed: ${String(error)}`);
    return { status: "failed", error: String(error) };
  }
  if (claim.status !== "claimed") {
    console.log(`[email] ${tag}: ${claim.status}, not sending`);
    return { status: claim.status };
  }

  const release = async () => {
    await releaseEmailSend(db, claim.id).catch((error: unknown) => {
      console.error(`[email] ${tag}: release failed: ${String(error)}`);
    });
  };

  let result;
  try {
    const email = build();
    result = await sendEmail(email, options);
  } catch (error) {
    await release();
    console.error(`[email] ${tag}: send failed: ${String(error)}`);
    return { status: "failed", error: String(error) };
  }

  if (!result.sent) {
    await release();
    console.log(`[email] ${tag}: skipped (${result.reason})`);
    return { status: "skipped", reason: result.reason };
  }

  // The provider accepted it, so the claim is never released from here: a retry would double-send.
  const stamped = await stampEmailSend(db, claim.id, result.id).catch(() => false);
  if (!stamped) {
    console.error(`[email] sent (${result.id}) but not recorded for ${tag}`);
  } else {
    console.log(`[email] ${tag}: sent (${result.id})`);
  }
  return { status: "sent", id: result.id };
}
