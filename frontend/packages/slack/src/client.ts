import { WebClient } from "@slack/web-api";
import { installer } from "./installer.js";

const RETRY = { retries: 3, maxRetryTime: 90_000 };

export function createSlackClient(decryptedBotToken: string): WebClient {
  return new WebClient(decryptedBotToken, { retryConfig: RETRY });
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
