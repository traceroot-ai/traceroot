import { createHash } from "node:crypto";

/**
 * Asks the backend whether a bearer credential is accepted, before a request
 * reaches the MCP SDK, so a credential the backend refuses gets an HTTP 401 a
 * client acts on (refresh, or sign in again) instead of a tool error.
 *
 * The probe is `GET /api/v1/public/sql/schema`: it takes every credential the
 * tools take (API key, OAuth token, CLI token) without a `project_id`, needs
 * no project data (the schema is static), and refuses a GET only on the
 * credential, never on the method, so its answer is about the credential.
 *
 * Verdicts are cached briefly by a hash of the credential, never the
 * credential itself: a revoked token is refused again within `ttlMs`.
 */

/** What the backend said about a credential. */
export type CredentialVerdict =
  /** Refused as invalid, expired or revoked (401): answer the client 401. */
  | { status: "invalid"; detail: string }
  /**
   * Anything else the backend decided: accepted, or a genuine credential it
   * refuses for another reason (403 no access, 400 needs a project). The tool
   * results carry that reason; signing in again would not change it.
   */
  | { status: "accepted" }
  /** No decision (outage, timeout, rate limit): let the request through, uncached. */
  | { status: "unknown" };

export interface CredentialCheckOptions {
  /** Origin of the Python public API (`rest`). */
  backendUrl: string;
  fetchImpl?: typeof fetch;
  /** How long a verdict is reused. */
  ttlMs?: number;
  /** Most verdicts held; the oldest goes first. */
  maxEntries?: number;
  /** Timeout for one probe; past it the verdict is unknown. */
  timeoutMs?: number;
  /** Clock override, for tests. */
  now?: () => number;
}

export const PROBE_PATH = "/api/v1/public/sql/schema";
const DEFAULT_TTL_MS = 30_000;
const DEFAULT_MAX_ENTRIES = 10_000;
const DEFAULT_TIMEOUT_MS = 5_000;
const INVALID_DETAIL = "The credential is invalid, expired or revoked";

type Cached = { verdict: CredentialVerdict; expiresAt: number };

export class CredentialCheck {
  private readonly cache = new Map<string, Cached>();
  private readonly inflight = new Map<string, Promise<CredentialVerdict>>();
  private readonly fetchImpl: typeof fetch;
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly timeoutMs: number;
  private readonly now: () => number;

  constructor(private readonly options: CredentialCheckOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.now = options.now ?? Date.now;
  }

  /** The backend's verdict on `bearer`, from the cache when fresh. */
  async check(bearer: string): Promise<CredentialVerdict> {
    const key = hashCredential(bearer);
    const cached = this.cache.get(key);
    if (cached && cached.expiresAt > this.now()) return cached.verdict;
    this.cache.delete(key);

    // Concurrent requests with one credential share one probe.
    let pending = this.inflight.get(key);
    if (!pending) {
      pending = this.probe(bearer).finally(() => this.inflight.delete(key));
      this.inflight.set(key, pending);
    }
    const verdict = await pending;
    if (verdict.status !== "unknown") this.remember(key, verdict);
    return verdict;
  }

  /** Record that the backend refused `bearer` on a tool call, so the next request gets the 401. */
  markInvalid(bearer: string, detail: string = INVALID_DETAIL): void {
    this.remember(hashCredential(bearer), { status: "invalid", detail });
  }

  private remember(key: string, verdict: CredentialVerdict): void {
    this.cache.delete(key);
    while (this.cache.size >= this.maxEntries) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
    this.cache.set(key, { verdict, expiresAt: this.now() + this.ttlMs });
  }

  private async probe(bearer: string): Promise<CredentialVerdict> {
    let response: Response;
    try {
      response = await this.fetchImpl(new URL(PROBE_PATH, this.options.backendUrl).toString(), {
        headers: { Authorization: `Bearer ${bearer}` },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      return { status: "unknown" };
    }
    if (response.status === 401) {
      return { status: "invalid", detail: await detailOf(response) };
    }
    // Drain the body so the connection can be reused.
    await response.body?.cancel().catch(() => undefined);
    if (response.status === 429 || response.status >= 500) return { status: "unknown" };
    return { status: "accepted" };
  }
}

/** The cache key: a credential is never held or logged in the clear. */
function hashCredential(bearer: string): string {
  return createHash("sha256").update(bearer).digest("hex");
}

/** The backend's `detail`, when it is a string; a fixed text otherwise. */
async function detailOf(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { detail?: unknown };
    if (typeof body.detail === "string" && body.detail.trim() !== "") return body.detail;
  } catch {
    // Not JSON: fall through to the fixed text.
  }
  return INVALID_DETAIL;
}
