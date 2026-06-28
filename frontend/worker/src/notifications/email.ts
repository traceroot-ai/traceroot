import nodemailer from "nodemailer";

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const SMTP_URL = process.env.TRACEROOT_SMTP_URL;
const SMTP_FROM = process.env.TRACEROOT_SMTP_MAIL_FROM || "noreply@traceroot.ai";
const APP_BASE_URL = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";

function createTransport() {
  if (!SMTP_URL) return null;
  const url = new URL(SMTP_URL);
  return nodemailer.createTransport({
    host: url.hostname,
    port: parseInt(url.port) || 587,
    secure: url.port === "465",
    auth: {
      user: decodeURIComponent(url.username),
      pass: decodeURIComponent(url.password),
    },
  });
}

/**
 * Send a combined alert email with the finding summary + RCA result in one message.
 * Sent after the RCA agent completes (or fails).
 * If rcaResult is null, sends a finding-only email (RCA failed fallback — never silent).
 */
export async function sendCombinedAlertEmail(params: {
  to: string[];
  detectorName: string;
  projectName: string;
  summary: string;
  traceId: string;
  projectId: string;
  rcaResult: string | null; // null = RCA did not complete
}): Promise<void> {
  const transport = createTransport();
  if (!transport || params.to.length === 0) return;

  const traceUrl = `${APP_BASE_URL}/projects/${params.projectId}/traces?traceId=${params.traceId}`;
  const shortTraceId = params.traceId.slice(0, 8);

  const hasRca = !!params.rcaResult;

  const textParts = [
    `${params.detectorName} fired on project ${params.projectName}.`,
    `Trace: ${params.traceId}`,
    ``,
    `Finding:`,
    params.summary,
    ``,
    hasRca ? `Root Cause Analysis:` : `Root cause analysis did not complete.`,
    ...(hasRca ? [params.rcaResult!, ``] : [``]),
    `View trace: ${traceUrl}`,
  ];

  const htmlRcaSection = hasRca
    ? `
<h3 style="margin-top:20px;font-size:14px;color:#333;">Root Cause Analysis</h3>
<pre style="background:#f6f6f6;padding:12px;border-radius:4px;font-size:13px;white-space:pre-wrap">${escapeHtml(params.rcaResult!)}</pre>`
    : `<p style="color:#888;font-size:13px;margin-top:16px;">Root cause analysis did not complete.</p>`;

  await transport.sendMail({
    from: SMTP_FROM,
    to: params.to.join(", "),
    subject: `[TraceRoot Alert] Trace ${shortTraceId} — ${params.projectName}`,
    text: textParts.join("\n"),
    html: `
<p><strong>${escapeHtml(params.detectorName)}</strong> fired on project <strong>${escapeHtml(params.projectName)}</strong>.</p>
<p style="color:#888;font-size:12px;font-family:monospace;">Trace: ${escapeHtml(params.traceId)}</p>
<h3 style="margin-top:16px;font-size:14px;color:#333;">Finding</h3>
<p>${escapeHtml(params.summary)}</p>
${htmlRcaSection}
<p style="margin-top:16px;"><a href="${traceUrl}">View trace in TraceRoot &rarr;</a></p>
    `.trim(),
  });
}

// Human-readable UTC window range, mirroring the digest Slack footer:
// "Jun 24, 14:00–15:00 UTC" (same day) or
// "Jun 23 23:50 – Jun 24 00:20 UTC" (cross-day). UTC keeps it unambiguous.
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

/**
 * Send a windowed digest email summarizing all findings in a time window:
 * one row per detector with its finding count and latest trace. No RCA and no
 * per-finding summary — matches the Slack digest content.
 */
export async function sendDigestAlertEmail(params: {
  to: string[];
  projectId: string;
  projectName: string;
  windowStart: Date;
  windowEnd: Date;
  total: number;
  entries: import("@traceroot/slack").DigestEntry[];
}): Promise<void> {
  const transport = createTransport();
  if (!transport || params.to.length === 0) return;

  const { projectId, projectName, windowStart, windowEnd, total, entries } = params;
  const noun = total === 1 ? "finding" : "findings";
  const windowRange = formatWindowRange(windowStart, windowEnd);

  // date_filter=custom is REQUIRED — the detector page only hydrates the custom
  // start/end when it is present; without it the deep-link lands on the default
  // range. Mirrors the Slack digest deep-link shape exactly.
  const range =
    `date_filter=custom` +
    `&start=${encodeURIComponent(windowStart.toISOString())}` +
    `&end=${encodeURIComponent(windowEnd.toISOString())}`;
  const findingsUrlFor = (detectorId: string) =>
    `${APP_BASE_URL}/projects/${encodeURIComponent(projectId)}/detectors/${encodeURIComponent(detectorId)}?${range}`;
  const traceUrlFor = (traceId: string) =>
    `${APP_BASE_URL}/projects/${encodeURIComponent(projectId)}/traces?traceId=${encodeURIComponent(traceId)}`;

  const textParts = [
    `${total} ${noun} in project ${projectName}.`,
    `${windowRange} · ${entries.length} detector${entries.length === 1 ? "" : "s"}`,
    ``,
  ];
  for (const e of entries) {
    const findingNoun = e.findingCount === 1 ? "finding" : "findings";
    textParts.push(
      `- ${e.detectorName} — ${e.findingCount} ${findingNoun} · latest ${e.latestTraceId.slice(0, 8)}`,
      `  ${findingsUrlFor(e.detectorId)}`,
    );
  }

  const htmlRows = entries
    .map((e) => {
      const findingNoun = e.findingCount === 1 ? "finding" : "findings";
      return `<p style="margin:6px 0;"><a href="${findingsUrlFor(e.detectorId)}">${escapeHtml(e.detectorName)}</a> <span style="color:#888;">— ${e.findingCount} ${findingNoun} · latest <a href="${traceUrlFor(e.latestTraceId)}" style="color:#888;">${e.latestTraceId.slice(0, 8)}</a></span></p>`;
    })
    .join("\n");

  await transport.sendMail({
    from: SMTP_FROM,
    to: params.to.join(", "),
    subject: `[TraceRoot Alert] ${total} ${noun} — ${projectName}`,
    text: textParts.join("\n"),
    html: `
<p><strong>${total} ${noun}</strong> in project <strong>${escapeHtml(projectName)}</strong>.</p>
<p style="color:#888;font-size:12px;">${windowRange} · ${entries.length} detector${entries.length === 1 ? "" : "s"}</p>
${htmlRows}
    `.trim(),
  });
}
