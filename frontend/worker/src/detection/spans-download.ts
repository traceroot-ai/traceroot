/**
 * Downloads a trace's spans from the Python backend's internal API.
 *
 * The download reuses pooled keep-alive connections, which the backend closes after 5 s
 * idle. A pooled socket reused just as that close arrives (likelier after a long synchronous
 * judge-input build has held the event loop) fails with a socket error, and the backend never
 * serves the request. The GET is idempotent, so such a failure is retried once on a new
 * connection; HTTP status errors are not retried, and a second failure throws.
 */
import { UnrecoverableError } from "bullmq";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";

const BACKEND_URL = process.env.BACKEND_INTERNAL_URL || "http://localhost:8000";
const INTERNAL_API_SECRET = process.env.INTERNAL_API_SECRET || "";

const STALE_SOCKET_CODES = new Set(["UND_ERR_SOCKET", "UND_ERR_CLOSED", "ECONNRESET", "EPIPE"]);

/** The code of a fetch error caused by the server closing the socket (before or mid-body), else undefined. */
function staleSocketCode(err: unknown): string | undefined {
  const code = (err as { cause?: { code?: unknown } } | null)?.cause?.code;
  return typeof code === "string" && STALE_SOCKET_CODES.has(code) ? code : undefined;
}

export async function downloadSpansJsonl(projectId: string, traceId: string): Promise<string> {
  const url = `${BACKEND_URL}/api/v1/internal/traces/${traceId}/spans-jsonl?project_id=${projectId}`;
  const headers = { "X-Internal-Secret": INTERNAL_API_SECRET };
  let status: number;
  try {
    const response = await fetch(url, { headers });
    if (response.ok) return await response.text();
    status = response.status;
  } catch (err) {
    const code = staleSocketCode(err);
    if (!code) throw err;
    console.warn(
      `[Detector] GET ${new URL(url).pathname} failed (${code}); retrying once on a new connection`,
    );
    const retried = await getOnNewConnection(url, { ...headers, "Accept-Encoding": "identity" });
    if (retried.status >= 200 && retried.status < 300) return retried.body;
    status = retried.status;
  }
  const message = `Failed to download spans for trace ${traceId}: HTTP ${status}`;
  if (status >= 400 && status < 500 && status !== 408 && status !== 429) {
    throw new UnrecoverableError(message);
  }
  throw new Error(message);
}

/** GET over a new connection that is closed afterwards (`agent: false`), so no pooled socket is reused. */
function getOnNewConnection(
  url: string,
  headers: Record<string, string>,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const send = url.startsWith("https:") ? httpsRequest : httpRequest;
    // node:http has no default timeout; match fetch's 300 s idle limit so a stalled retry can't hang the job.
    const req = send(url, { headers, agent: false, timeout: 300_000 }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => (body += chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      res.on("error", reject);
    });
    req.on("timeout", () => req.destroy(new Error(`No data from ${url} for 300 s`)));
    req.on("error", reject);
    req.end();
  });
}
