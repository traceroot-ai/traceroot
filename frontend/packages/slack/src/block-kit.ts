const SECTION_LIMIT = 3000;

// Render cap for the LLM digest paragraph — readability bound, far under the
// 3000-char Slack section limit. Shared with the email digest.
export const DIGEST_SUMMARY_RENDER_CAP = 700;

function escapeMrkdwn(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function truncate(text: string, max = SECTION_LIMIT): string {
  if (text.length <= max) return text;
  return text.slice(0, max - 1) + "…";
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
  /** Optional LLM-written paragraph; untrusted text — escaped + capped at render. */
  summary?: string;
}

// Human-readable UTC window range for the digest footer, e.g.
// "Jun 23, 12:00–12:30 UTC" (same day) or "Jun 23 23:50 – Jun 24 00:20 UTC".
// UTC keeps it unambiguous across a channel's mixed timezones. Exported so the
// email digest renders the identical range without duplicating the formatter.
export function formatWindowRange(start: Date, end: Date): string {
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
// header, two dividers, and the footer, leaving 46 for the per-detector lines
// (one fewer when a summary section is rendered).
const MAX_DIGEST_LINES = 46;

// Deep-link to a detector's findings page, scoped to the digest window. Shared by
// the Slack and email digests so the URL contract lives in one place.
// date_filter=custom is REQUIRED — the detector page's useUrlDateFilter only
// hydrates a custom start/end when date_filter=custom is present; without it
// start/end are ignored and the link lands on the default range.
export function detectorFindingsUrl(
  appBaseUrl: string,
  projectId: string,
  detectorId: string,
  windowStart: Date,
  windowEnd: Date,
): string {
  const range =
    `date_filter=custom` +
    `&start=${encodeURIComponent(windowStart.toISOString())}` +
    `&end=${encodeURIComponent(windowEnd.toISOString())}`;
  return `${appBaseUrl}/projects/${encodeURIComponent(projectId)}/detectors/${encodeURIComponent(detectorId)}?${range}`;
}

// Deep-link to a single trace in the trace viewer.
export function traceUrl(appBaseUrl: string, projectId: string, traceId: string): string {
  return `${appBaseUrl}/projects/${encodeURIComponent(projectId)}/traces?traceId=${encodeURIComponent(traceId)}`;
}

export function buildDigestAlertBlocks(params: DigestAlertParams): unknown[] {
  const { appBaseUrl, projectId, projectName, windowStart, windowEnd, total, entries, summary } =
    params;
  const noun = total === 1 ? "finding" : "findings";
  const headerText = truncate(`${total} ${noun} in ${projectName}`, 150);

  // Cap after escaping; strip a trailing partial escape entity from the cut
  // string so a cap-hitting summary never ends "…&am…".
  const capSummary = (s: string) =>
    s.length > DIGEST_SUMMARY_RENDER_CAP
      ? s.slice(0, DIGEST_SUMMARY_RENDER_CAP - 1).replace(/&[a-z]*$/, "") + "…"
      : s;

  const summaryText = summary?.trim();
  const summaryBlocks = summaryText
    ? [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: capSummary(escapeMrkdwn(summaryText)),
          },
        },
      ]
    : [];

  // The summary consumes one of Slack's 50 blocks: shrink the row budget so
  // the total never exceeds the limit.
  const maxLines = summaryBlocks.length ? MAX_DIGEST_LINES - 1 : MAX_DIGEST_LINES;

  // Cap the rendered detector lines so a project with many triggered detectors
  // can't blow the 50-block limit and fail the whole send. When we truncate,
  // one line is spent on an overflow note, so one fewer detector is listed.
  const overflow = entries.length > maxLines;
  const shown = overflow ? entries.slice(0, maxLines - 1) : entries;

  const lines = shown.map((e) => {
    const findingsUrl = detectorFindingsUrl(
      appBaseUrl,
      projectId,
      e.detectorId,
      windowStart,
      windowEnd,
    );
    const shortTrace = e.latestTraceId.slice(0, 8);
    // Escape the detector name (user-controlled); URLs are built from encoded
    // params, so escaping them would mangle the query-string separators and
    // break the Slack <url|text> link syntax.
    const name = escapeMrkdwn(e.detectorName);
    const text =
      `*<${findingsUrl}|${name}>* — ${e.findingCount} ${e.findingCount === 1 ? "finding" : "findings"}` +
      (e.latestTraceId
        ? ` · latest: <${traceUrl(appBaseUrl, projectId, e.latestTraceId)}|${shortTrace}>`
        : "");
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
    ...summaryBlocks,
    ...lines,
    { type: "divider" },
    { type: "context", elements: [{ type: "mrkdwn", text: footer }] },
  ];
}
