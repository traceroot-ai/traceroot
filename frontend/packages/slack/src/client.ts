import { WebClient } from "@slack/web-api";
import { installer } from "./installer.ts";

const RETRY = { retries: 3, maxRetryTime: 90_000 };

/**
 * A caller that is holding a request open passes its own bound: the default rides out
 * a Slack outage for up to a minute and a half, which a background job can afford and
 * a user waiting on a response cannot. A bound also rejects a rate-limited call at
 * once: otherwise a 429 makes the client wait out its `Retry-After` before throwing,
 * whatever the timeout and retry count say.
 */
export function createSlackClient(
  decryptedBotToken: string,
  bound?: { timeoutMs: number; retries: number },
): WebClient {
  return new WebClient(
    decryptedBotToken,
    bound === undefined
      ? { retryConfig: RETRY }
      : {
          timeout: bound.timeoutMs,
          retryConfig: { retries: bound.retries },
          rejectRateLimitedCalls: true,
        },
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
