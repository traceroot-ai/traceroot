import { checkMintRateLimit, rateLimitClientKey } from "@/lib/mint-rate-limit";

// Browsers POST here when a page's Content-Security-Policy blocks something
// (report-uri in lib/csp.ts), so a gap in the policy shows up in the server log
// before anyone reports a broken page. Browsers send reports without the
// session, so the route is public: it reads at most MAX_BODY_BYTES and logs a few
// fields with query strings removed (a document URL can carry an OAuth code).
// Each client gets its own logging budget, so one sender cannot use up the
// instance's and hide everyone else's reports; the instance cap bounds the log
// under a flood from many addresses.

const MAX_BODY_BYTES = 16 * 1024;
const REPORTS_PER_CLIENT_PER_MINUTE = 20;
const REPORTS_PER_MINUTE = 300;
// Browser extensions inject their own scripts into pages; reports about those
// say nothing about the app.
const EXTENSION_URL = /^(chrome|moz|safari|safari-web|ms-browser)-extension:/;

let windowStart = 0;
let loggedInWindow = 0;

export async function POST(req: Request): Promise<Response> {
  const body = await readCapped(req, MAX_BODY_BYTES);
  if (body === null) {
    return new Response(null, { status: 413 });
  }
  let report: unknown;
  try {
    report = (JSON.parse(body) as { "csp-report"?: unknown })?.["csp-report"];
  } catch {
    return new Response(null, { status: 400 });
  }
  if (!report || typeof report !== "object") {
    return new Response(null, { status: 400 });
  }

  const fields = report as Record<string, unknown>;
  const blocked = String(fields["blocked-uri"] ?? "");
  const source = String(fields["source-file"] ?? "");
  if (
    !EXTENSION_URL.test(blocked) &&
    !EXTENSION_URL.test(source) &&
    // Its own bucket: sharing the CLI routes' budget would let a page's reports
    // throttle that user's CLI sign-in.
    checkMintRateLimit(
      `csp-report:${rateLimitClientKey(req.headers)}`,
      REPORTS_PER_CLIENT_PER_MINUTE,
      60_000,
    ) &&
    takeLogSlot(Date.now())
  ) {
    console.warn(
      "[csp-report]",
      JSON.stringify({
        directive: fields["effective-directive"] ?? fields["violated-directive"],
        blocked: withoutQuery(blocked),
        document: withoutQuery(String(fields["document-uri"] ?? "")),
        source: withoutQuery(source),
        line: fields["line-number"],
        disposition: fields["disposition"],
      }),
    );
  }
  return new Response(null, { status: 204 });
}

async function readCapped(req: Request, max: number): Promise<string | null> {
  if (Number(req.headers.get("content-length") ?? 0) > max) return null;
  if (!req.body) return "";
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function takeLogSlot(now: number): boolean {
  if (now - windowStart >= 60_000) {
    windowStart = now;
    loggedInWindow = 0;
  }
  loggedInWindow += 1;
  return loggedInWindow <= REPORTS_PER_MINUTE;
}

function withoutQuery(url: string): string {
  return url.split(/[?#]/, 1)[0];
}
