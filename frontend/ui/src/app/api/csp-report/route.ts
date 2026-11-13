import { checkMintRateLimit, rateLimitClientKey } from "@/lib/mint-rate-limit";

// Browsers POST here when a page's Content-Security-Policy blocks something
// (report-to and report-uri in lib/csp.ts), so a gap in the policy shows up in
// the server log before anyone reports a broken page. Browsers send reports
// without the session, so the route is public: it reads at most MAX_BODY_BYTES
// and logs a few fields with query strings removed (a document URL can carry an
// OAuth code). Each client gets its own logging budget, so one sender cannot use
// up the instance's and hide everyone else's reports; the instance cap bounds the
// log under a flood from many addresses.

const MAX_BODY_BYTES = 16 * 1024;
const REPORTS_PER_CLIENT_PER_MINUTE = 20;
const REPORTS_PER_MINUTE = 300;
// Browser extensions inject their own scripts into pages; reports about those
// say nothing about the app.
const EXTENSION_URL = /^(chrome|moz|safari|safari-web|ms-browser)-extension:/;

let windowStart = 0;
let loggedInWindow = 0;

interface Violation {
  directive: unknown;
  blocked: string;
  document: string;
  source: string;
  line: unknown;
  disposition: unknown;
}

export async function POST(req: Request): Promise<Response> {
  const body = await readCapped(req, MAX_BODY_BYTES);
  if (body === null) {
    return new Response(null, { status: 413 });
  }
  let violations: Violation[] | null;
  try {
    violations = parseViolations(JSON.parse(body));
  } catch {
    return new Response(null, { status: 400 });
  }
  if (violations === null) {
    return new Response(null, { status: 400 });
  }

  for (const violation of violations) {
    if (EXTENSION_URL.test(violation.blocked) || EXTENSION_URL.test(violation.source)) {
      continue;
    }
    if (
      // Its own bucket: sharing the CLI routes' budget would let a page's reports
      // throttle that user's CLI sign-in.
      !checkMintRateLimit(
        `csp-report:${rateLimitClientKey(req.headers)}`,
        REPORTS_PER_CLIENT_PER_MINUTE,
        60_000,
      ) ||
      !takeLogSlot(Date.now())
    ) {
      break;
    }
    console.warn(
      "[csp-report]",
      JSON.stringify({
        directive: violation.directive,
        blocked: withoutQuery(violation.blocked),
        document: withoutQuery(violation.document),
        source: withoutQuery(violation.source),
        line: violation.line,
        disposition: violation.disposition,
      }),
    );
  }
  return new Response(null, { status: 204 });
}

// report-uri posts a single {"csp-report": {...}} with hyphenated field names.
// report-to posts a batch: an array of reports, where a CSP violation has type
// "csp-violation" and camelCase fields under body. Anything else is null.
function parseViolations(payload: unknown): Violation[] | null {
  if (Array.isArray(payload)) {
    return payload.flatMap((report: unknown): Violation[] => {
      if (!isRecord(report) || report.type !== "csp-violation" || !isRecord(report.body)) {
        return [];
      }
      const fields = report.body;
      return [
        {
          directive: fields.effectiveDirective,
          blocked: String(fields.blockedURL ?? ""),
          document: String(fields.documentURL ?? ""),
          source: String(fields.sourceFile ?? ""),
          line: fields.lineNumber,
          disposition: fields.disposition,
        },
      ];
    });
  }
  const fields = isRecord(payload) ? payload["csp-report"] : undefined;
  if (!isRecord(fields)) {
    return null;
  }
  return [
    {
      directive: fields["effective-directive"] ?? fields["violated-directive"],
      blocked: String(fields["blocked-uri"] ?? ""),
      document: String(fields["document-uri"] ?? ""),
      source: String(fields["source-file"] ?? ""),
      line: fields["line-number"],
      disposition: fields["disposition"],
    },
  ];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
