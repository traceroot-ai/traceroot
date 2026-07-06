import nodemailer from "nodemailer";
import {
  detectorFindingsUrl,
  formatWindowRange,
  traceUrl,
  type DigestEntry,
} from "@traceroot/slack";
import type { UsageMeter } from "@traceroot/core";

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

// Copy for the free-plan usage-quota emails. The blocked line names exactly
// what paused: for the automatic meters (rca, detector) there is no
// interactive tell, so the email is the only signal the feature stopped.
const USAGE_METER_COPY: Record<UsageMeter, { label: string; pausedCopy: string }> = {
  events: {
    label: "events",
    pausedCopy: "Trace and span ingestion is paused — new telemetry is being dropped.",
  },
  rca: {
    label: "root-cause analysis runs",
    pausedCopy:
      "Automatic root-cause analysis is paused — new detector findings will not be analyzed.",
  },
  detector: {
    label: "detector runs",
    pausedCopy: "Detector scans are paused — incoming traces are no longer being scanned.",
  },
};

/**
 * Send a free-plan usage-quota email (80% warning or 100% blocked) to
 * workspace admins. Returns true ONLY when the message was handed to the
 * transport, so callers can stamp sent-state on real sends and retry
 * transient failures (no SMTP config, empty recipient list, SMTP error)
 * on the next billing run.
 */
export async function sendUsageQuotaEmail(params: {
  to: string[];
  kind: "warning" | "blocked";
  meter: UsageMeter;
  workspaceId: string;
  workspaceName: string;
  used: number;
  cap: number;
}): Promise<boolean> {
  const transport = createTransport();
  if (!transport || params.to.length === 0) return false;

  const { kind, meter, workspaceId, workspaceName, used, cap } = params;
  const copy = USAGE_METER_COPY[meter];
  const billingUrl = `${APP_BASE_URL}/workspaces/${workspaceId}/settings/billing`;
  const usedStr = used.toLocaleString("en-US");
  const capStr = cap.toLocaleString("en-US");

  const subject =
    kind === "warning"
      ? `[TraceRoot] ${workspaceName}: approaching your free-plan ${copy.label} limit`
      : `[TraceRoot] ${workspaceName}: free-plan ${copy.label} limit reached`;
  const cta =
    kind === "warning"
      ? "Upgrade your plan to avoid interruption once the limit is reached."
      : "Upgrade your plan to resume immediately.";

  const text = [
    `${workspaceName} has used ${usedStr} of ${capStr} free-plan ${copy.label}.`,
    ...(kind === "blocked" ? [copy.pausedCopy] : []),
    cta,
    billingUrl,
  ].join("\n");

  const html = `
<p><strong>${escapeHtml(workspaceName)}</strong> has used <strong>${usedStr}</strong> of <strong>${capStr}</strong> free-plan ${copy.label}.</p>
${kind === "blocked" ? `<p>${copy.pausedCopy}</p>` : ""}
<p>${cta}</p>
<p><a href="${billingUrl}">Manage your plan</a></p>
  `.trim();

  try {
    await transport.sendMail({
      from: SMTP_FROM,
      to: params.to.join(", "),
      subject,
      text,
      html,
    });
    return true;
  } catch (error) {
    console.error(
      `[Billing] Failed to send usage ${kind} email for workspace ${workspaceId} (${meter}):`,
      error,
    );
    return false;
  }
}
