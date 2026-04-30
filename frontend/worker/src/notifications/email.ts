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
    subject: `[Traceroot Alert] Trace ${shortTraceId} — ${params.projectName}`,
    text: textParts.join("\n"),
    html: `
<p><strong>${escapeHtml(params.detectorName)}</strong> fired on project <strong>${escapeHtml(params.projectName)}</strong>.</p>
<p style="color:#888;font-size:12px;font-family:monospace;">Trace: ${escapeHtml(params.traceId)}</p>
<h3 style="margin-top:16px;font-size:14px;color:#333;">Finding</h3>
<p>${escapeHtml(params.summary)}</p>
${htmlRcaSection}
<p style="margin-top:16px;"><a href="${traceUrl}">View trace in Traceroot &rarr;</a></p>
    `.trim(),
  });
}
