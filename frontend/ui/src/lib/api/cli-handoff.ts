/**
 * Minting the one-time code that signs a terminal in without a browser page.
 *
 * Browser-first onboarding ends by printing a `traceroot setup` command. The
 * terminal it is pasted into holds no credential, so `setup` would run the
 * device flow and open a *second* browser page — for the account that signed in
 * in the first one a minute ago — and both pages would then wait for the same
 * first trace. A handoff code on the printed line is what removes that page:
 * the CLI exchanges it for an ordinary session and never opens a browser.
 *
 * What is minted here is a ticket, not a credential. It buys one call to one
 * redemption endpoint, it is single-use, and it is dead within ten minutes — by
 * which time the legitimate run has almost always spent it, because `setup`
 * authenticates at the second stage of its pipeline.
 */
import { fetchNextApi } from "./client";

export interface CliHandoff {
  /**
   * `trh_` followed by 43 base64url characters.
   *
   * Goes on the printed command as a bare word; `setupCommand` holds it to the
   * same shell-safety rule as the project id and omits the flag rather than
   * quote anything that fails it.
   */
  code: string;
  /** How long the code stays redeemable, in seconds from when it was minted. */
  expiresIn: number;
  /** The same deadline as an absolute time, for display or logging. */
  expiresAt: string;
}

/**
 * Mint a handoff for the signed-in user, recorded against this project.
 *
 * Cookie-authenticated, like every other `/api/...` route this client calls.
 * The project is not an authorization scope — the session the code yields is
 * user-scoped, exactly as a device-flow approval's would be — it is what the
 * route audits the mint against and what the CLI can name back to the user.
 */
export async function createCliHandoff(projectId: string): Promise<CliHandoff> {
  return fetchNextApi<CliHandoff>("/cli/handoff", {
    method: "POST",
    body: JSON.stringify({ projectId }),
  });
}

/**
 * The ids of the signed-in user's sessions that a handoff code created.
 *
 * Active Sessions matches these against better-auth's session list to mark
 * those rows: a handoff session's row is otherwise identical to a device-flow
 * login's, and it is the one kind of session nobody approved on a page. May
 * include sessions that no longer exist.
 */
export async function listCliHandoffSessionIds(): Promise<string[]> {
  const { sessionIds } = await fetchNextApi<{ sessionIds: string[] }>("/cli/handoff/sessions");
  return sessionIds;
}
