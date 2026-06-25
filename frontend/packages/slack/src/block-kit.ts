const SECTION_LIMIT = 3000;

function escapeMrkdwn(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Bounded quantifiers keep the link-text + URL classes from backtracking
// quadratically on hostile input (CodeQL js/polynomial-redos). 500 is well
// above any realistic markdown link we emit in detector/RCA output.
const LINK_PART_MAX = 500;
const MD_LINK_RE = new RegExp(
  `\\[([^\\]]{1,${LINK_PART_MAX}})\\]\\(([^)]{1,${LINK_PART_MAX}})\\)`,
  "g",
);

function mdLinksToSlack(text: string): string {
  return text.replace(MD_LINK_RE, "<$2|$1>");
}

function truncate(text: string, max = SECTION_LIMIT): string {
  if (text.length <= max) return text;
  return text.slice(0, max - 1) + "…";
}

function mrkdwnSection(raw: string) {
  const formatted = truncate(mdLinksToSlack(escapeMrkdwn(raw)));
  return { type: "section", text: { type: "mrkdwn", text: formatted } };
}

export interface CombinedAlertParams {
  detectorName: string;
  projectName: string;
  summary: string;
  traceId: string;
  projectId: string;
  appBaseUrl: string;
  rcaResult: string | null;
}

export function buildCombinedAlertBlocks(params: CombinedAlertParams): unknown[] {
  const traceUrl = `${params.appBaseUrl}/projects/${encodeURIComponent(params.projectId)}/traces?traceId=${encodeURIComponent(params.traceId)}`;
  const shortTrace = params.traceId.slice(0, 8);

  const headerText = truncate(`${params.detectorName} fired`, 150);
  const projectLine = `*Project:* \`${params.projectName}\`  ·  *Trace:* \`${shortTrace}\``;

  const rcaSection = params.rcaResult
    ? mrkdwnSection(`*Root cause analysis*\n${params.rcaResult}`)
    : {
        type: "section",
        text: { type: "mrkdwn", text: "_Root cause analysis did not complete._" },
      };

  return [
    { type: "header", text: { type: "plain_text", text: headerText, emoji: true } },
    mrkdwnSection(projectLine),
    mrkdwnSection(`*Finding*\n${params.summary}`),
    { type: "divider" },
    rcaSection,
    {
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "View trace" },
          url: traceUrl,
        },
      ],
    },
  ];
}

export interface DigestEntry {
  detectorId: string;
  detectorName: string;
  findingCount: number;
  latestTraceId: string;
}

export interface DigestAlertParams {
  projectId: string;
  projectName: string;
  appBaseUrl: string;
  windowStart: Date;
  windowEnd: Date;
  total: number;
  entries: DigestEntry[];
}

// Human-readable UTC window range for the digest footer, e.g.
// "Jun 23, 12:00–12:30 UTC" (same day) or "Jun 23, 23:50 – Jun 24, 00:20 UTC".
// UTC keeps it unambiguous across a channel's mixed timezones.
function formatWindowRange(start: Date, end: Date): string {
  const day = (d: Date) =>
    new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" }).format(d);
  const time = (d: Date) =>
    new Intl.DateTimeFormat("en-US", {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
      timeZone: "UTC",
    }).format(d);
  return day(start) === day(end)
    ? `${day(start)}, ${time(start)}–${time(end)} UTC`
    : `${day(start)} ${time(start)} – ${day(end)} ${time(end)} UTC`;
}

// Slack rejects a message with more than 50 blocks. The digest spends 4 on the
// header, two dividers, and the footer, leaving 46 for the per-detector lines.
const MAX_DIGEST_LINES = 46;

export function buildDigestAlertBlocks(params: DigestAlertParams): unknown[] {
  const { appBaseUrl, projectId, projectName, windowStart, windowEnd, total, entries } = params;
  const noun = total === 1 ? "finding" : "findings";
  const headerText = truncate(`${total} ${noun} in ${projectName}`, 150);

  // Cap the rendered detector lines so a project with many triggered detectors
  // can't blow the 50-block limit and fail the whole send. When we truncate,
  // one line is spent on an overflow note, so only 45 detectors are listed.
  const overflow = entries.length > MAX_DIGEST_LINES;
  const shown = overflow ? entries.slice(0, MAX_DIGEST_LINES - 1) : entries;

  // date_filter=custom is REQUIRED — the detector page's useUrlDateFilter only
  // hydrates a custom start/end when date_filter=custom is present; without it
  // start/end are ignored and the deep-link lands on the default range.
  const range =
    `date_filter=custom` +
    `&start=${encodeURIComponent(windowStart.toISOString())}` +
    `&end=${encodeURIComponent(windowEnd.toISOString())}`;

  const lines = shown.map((e) => {
    const findingsUrl = `${appBaseUrl}/projects/${encodeURIComponent(projectId)}/detectors/${encodeURIComponent(e.detectorId)}?${range}`;
    const traceUrl = `${appBaseUrl}/projects/${encodeURIComponent(projectId)}/traces?traceId=${encodeURIComponent(e.latestTraceId)}`;
    const shortTrace = e.latestTraceId.slice(0, 8);
    // Escape the detector name (user-controlled); the URL is built from encoded
    // params, so escaping it would mangle the query-string separators and break
    // the Slack <url|text> link syntax.
    const name = escapeMrkdwn(e.detectorName);
    const text =
      `*<${findingsUrl}|${name}>* — ${e.findingCount} ${e.findingCount === 1 ? "finding" : "findings"}` +
      (e.latestTraceId ? ` · latest: <${traceUrl}|${shortTrace}>` : "");
    return { type: "section", text: { type: "mrkdwn", text: truncate(text) } };
  });

  if (overflow) {
    const more = entries.length - shown.length;
    lines.push({
      type: "section",
      text: { type: "mrkdwn", text: `_+${more} more detector${more === 1 ? "" : "s"}_` },
    });
  }

  const detectorCount = entries.length;
  const footer =
    `${formatWindowRange(windowStart, windowEnd)} · ` +
    `${detectorCount} detector${detectorCount === 1 ? "" : "s"}`;

  return [
    { type: "header", text: { type: "plain_text", text: headerText, emoji: true } },
    { type: "divider" },
    ...lines,
    { type: "divider" },
    { type: "context", elements: [{ type: "mrkdwn", text: footer }] },
  ];
}
