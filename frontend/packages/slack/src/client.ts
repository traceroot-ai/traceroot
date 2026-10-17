import { WebClient } from "@slack/web-api";
import { installer } from "./installer.ts";

const RETRY = { retries: 3, maxRetryTime: 90_000 };

/**
 * A caller that is holding a request open passes its own bound: the default rides out
 * a Slack outage for up to a minute and a half, which a background job can afford and
 * a user waiting on a response cannot.
 */
export function createSlackClient(
  decryptedBotToken: string,
  bound?: { timeoutMs: number; retries: number },
): WebClient {
  return new WebClient(
    decryptedBotToken,
    bound === undefined
      ? { retryConfig: RETRY }
      : { timeout: bound.timeoutMs, retryConfig: { retries: bound.retries } },
  );
}

export async function getClientForTeam(teamId: string): Promise<WebClient> {
  const auth = await installer.authorize({
    teamId,
    enterpriseId: undefined,
    isEnterpriseInstall: false,
  });
  if (!auth.botToken) throw new Error(`No bot token for team ${teamId}`);
  return new WebClient(auth.botToken, { retryConfig: RETRY });
}

export type { WebClient };
