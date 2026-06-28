import nodemailer from "nodemailer";
import {
  detectorFindingsUrl,
  formatWindowRange,
  traceUrl,
  type DigestEntry,
} from "@traceroot/slack";

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
  entries: DigestEntry[];
}): Promise<void> {
  const transport = createTransport();
  if (!transport || params.to.length === 0) return;

  const { projectId, projectName, windowStart, windowEnd, total, entries } = params;
  const noun = total === 1 ? "finding" : "findings";
  const windowRange = formatWindowRange(windowStart, windowEnd);

  // Reuse the shared deep-link helpers (block-kit) so the URL contract lives in
  // one place; curry them with this email's base URL + window.
  const findingsUrlFor = (detectorId: string) =>
    detectorFindingsUrl(APP_BASE_URL, projectId, detectorId, windowStart, windowEnd);
  const traceUrlFor = (traceId: string) => traceUrl(APP_BASE_URL, projectId, traceId);

  const textParts = [
    `${total} ${noun} in project ${projectName}.`,
    `${windowRange} · ${entries.length} detector${entries.length === 1 ? "" : "s"}`,
    ``,
  ];
  for (const e of entries) {
    const findingNoun = e.findingCount === 1 ? "finding" : "findings";
    // Omit the trace segment when there is no latest trace (mirrors the Slack
    // builder), so we never emit a blank/broken trace link.
    const latest = e.latestTraceId ? ` · latest ${e.latestTraceId.slice(0, 8)}` : "";
    textParts.push(
      `- ${e.detectorName} — ${e.findingCount} ${findingNoun}${latest}`,
      `  ${findingsUrlFor(e.detectorId)}`,
    );
  }

  const htmlRows = entries
    .map((e) => {
      const findingNoun = e.findingCount === 1 ? "finding" : "findings";
      const latest = e.latestTraceId
        ? ` · latest <a href="${traceUrlFor(e.latestTraceId)}" style="color:#888;">${e.latestTraceId.slice(0, 8)}</a>`
        : "";
      return `<p style="margin:6px 0;"><a href="${findingsUrlFor(e.detectorId)}">${escapeHtml(e.detectorName)}</a> <span style="color:#888;">— ${e.findingCount} ${findingNoun}${latest}</span></p>`;
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
