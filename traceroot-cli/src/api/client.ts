/**
 * Thin HTTP client built on native fetch (Node >= 20).
 *
 * Design decisions:
 *  - No axios or node-fetch — Node 20 global fetch is sufficient.
 *  - ApiError carries status code and raw body for callers to handle.
 *  - Timeout is implemented with AbortController so it works with any fetch.
 *  - All methods are generic so callers can type the response against
 *    the generated types in src/api/generated/.
 */

export class ApiError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
    public readonly body?: unknown,
  ) {
    super(`HTTP ${statusCode}: ${message}`);
    this.name = "ApiError";
  }
}

export interface ApiClientOptions {
  apiUrl: string;
  token: string;
  /** Request timeout in milliseconds. Default: 30 000. */
  timeoutMs?: number;
}

export class ApiClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly timeoutMs: number;

  constructor({ apiUrl, token, timeoutMs = 30_000 }: ApiClientOptions) {
    // Strip trailing slash so path concatenation is consistent.
    this.baseUrl = apiUrl.replace(/\/$/, "");
    this.token = token;
    this.timeoutMs = timeoutMs;
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    let response: Response;
    try {
      response = await fetch(url, {
        method,
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${this.token}`,
          "Content-Type": "application/json",
          Accept: "application/json",
          "User-Agent": "traceroot-cli/0.1.0",
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        throw new ApiError(0, `Request timed out after ${this.timeoutMs}ms`);
      }
      throw new ApiError(0, err instanceof Error ? err.message : String(err));
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      let errBody: unknown;
      try {
        // Read as text first — response.json() consumes the body stream,
        // making a subsequent .text() call throw.  Non-JSON bodies (HTML
        // error pages, plain text) are common from proxies and gateways.
        const raw = await response.text();
        try {
          errBody = JSON.parse(raw);
        } catch {
          errBody = raw;
        }
      } catch {
        // Body already consumed or network error — leave as undefined.
      }
      throw new ApiError(response.status, response.statusText, errBody);
    }

    if (response.status === 204 || response.headers.get("content-length") === "0") {
      return undefined as T;
    }

    return response.json() as Promise<T>;
  }

  get<T>(path: string): Promise<T> {
    return this.request<T>("GET", path);
  }

  post<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>("POST", path, body);
  }
}
