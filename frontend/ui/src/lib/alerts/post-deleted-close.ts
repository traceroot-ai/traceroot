// Posts the [OK] that closes the page of an alert rule deleted while it was open.
// The worker sends every other close, off a marker on the rule; a delete leaves no
// rule to carry one, so the delete sends its own, once and best-effort.
import { decryptKey } from "@traceroot/core";
import {
  buildAlertClosedBlocks,
  createSlackClient,
  resolveAlertChannel,
  type WebClient,
} from "@traceroot/slack";

const APP_BASE_URL = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";

type SlackAttachments = Extract<
  NonNullable<Parameters<WebClient["chat"]["postMessage"]>[0]>,
  { attachments: unknown }
>["attachments"];

/** The delete is waiting on this, so it gets one short try and no retries. */
const SLACK_BOUND = { timeoutMs: 3_000, retries: 0 };

export interface DeletedAlertClose {
  projectId: string;
  alertId: string;
  /** User-controlled; escaped by the block builder. */
  name: string;
  /** The deleter's display name. Null when they have none: the channel never gets an email. */
  actorName: string | null;
}

/**
 * Never throws. Every way it can fail (no channel, no entitlement, a token that will
 * not decrypt, Slack refusing or timing out) is logged and dropped: the rule is already
 * deleted, and a close that did not go out is not a reason to tell the user it was not.
 */
export async function postDeletedAlertClose(close: DeletedAlertClose): Promise<void> {
  const tag = `alert=${close.alertId} project=${close.projectId}`;
  try {
    const resolution = await resolveAlertChannel(close.projectId);
    if (!resolution.ok) {
      console.info(`[alerts] deleted close skipped ${tag} reason=${resolution.reason}`);
      return;
    }

    const message = buildAlertClosedBlocks({
      appBaseUrl: APP_BASE_URL,
      projectId: close.projectId,
      alertId: close.alertId,
      name: close.name,
      reason: "deleted",
      actor: close.actorName,
    });
    const botToken = decryptKey(resolution.target.encryptedBotToken);
    await createSlackClient(botToken, SLACK_BOUND).chat.postMessage({
      channel: resolution.target.channelId,
      attachments: [{ color: message.color, blocks: message.blocks }] as SlackAttachments,
      text: message.text,
      unfurl_links: false,
      unfurl_media: false,
    });
  } catch (error) {
    console.error(`[alerts] deleted close not sent ${tag}:`, error);
  }
}
