/** Error raised for non-2xx API responses, carrying the backend's detail message. */
export class ApiError extends Error {
  readonly status: number;
  readonly detail: string;

  constructor(status: number, detail: string) {
    super(`API error ${status}: ${detail}`);
    this.name = "ApiError";
    this.status = status;
    this.detail = detail;
  }
}

/** Headers for public-API access with a TraceRoot API key. */
export function bearerAuth(apiKey: string): Record<string, string> {
  return { Authorization: `Bearer ${apiKey}` };
}

/** Headers for internal-API access on behalf of a user (service-to-service). */
export function internalAuth(secret: string, userId: string): Record<string, string> {
  return { "X-Internal-Secret": secret, "x-user-id": userId };
}

export interface ApiClientOptions {
  /** Origin (plus optional prefix) the paths are resolved against, e.g. "https://api.example.com". */
  baseUrl: string;
  /** Headers sent with every request (auth, content negotiation). */
  headers: Record<string, string>;
  /** Fetch implementation override, for tests. Defaults to the global fetch. */
  fetchImpl?: typeof fetch;
  /** Per-request timeout; no timeout when omitted. */
  timeoutMs?: number;
}

/** Minimal HTTP client the dispatcher calls registry entries through. */
export class ApiClient {
  private readonly options: ApiClientOptions;

  constructor(options: ApiClientOptions) {
    this.options = options;
  }

  async request(
    method: "get",
    path: string,
    query: Record<string, string>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const url = new URL(this.options.baseUrl.replace(/\/$/, "") + path);
    for (const [name, value] of Object.entries(query)) {
      url.searchParams.set(name, value);
    }

    const signals: AbortSignal[] = [];
    if (signal !== undefined) {
      signals.push(signal);
    }
    if (this.options.timeoutMs !== undefined) {
      signals.push(AbortSignal.timeout(this.options.timeoutMs));
    }

    const fetchImpl = this.options.fetchImpl ?? fetch;
    const response = await fetchImpl(url.toString(), {
      method: method.toUpperCase(),
      headers: this.options.headers,
      signal: signals.length > 0 ? AbortSignal.any(signals) : undefined,
    });

    if (!response.ok) {
      const body = await response.text();
      let detail = body;
      try {
        const parsed = JSON.parse(body) as { detail?: unknown };
        if (typeof parsed.detail === "string") {
          detail = parsed.detail;
        }
      } catch {
        // non-JSON error body: keep the raw text as the detail
      }
      throw new ApiError(response.status, detail);
    }

    return response.json();
  }
}
