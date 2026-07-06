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
// Same logo source as the workspace-invite email in frontend/ui.
const LOGO_URL =
  process.env.NEXT_PUBLIC_LOGO_URL ||
  "https://raw.githubusercontent.com/traceroot-ai/traceroot/main/frontend/ui/public/images/traceroot_icon.png";

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
      ? `[TraceRoot] ${workspaceName}: approaching your free plan ${copy.label} limit`
      : `[TraceRoot] ${workspaceName}: free plan ${copy.label} limit reached`;
  const cta =
    kind === "warning"
      ? "Upgrade your plan to avoid interruption once the limit is reached."
      : "Upgrade your plan to resume immediately.";

  const text = [
    `${workspaceName} has used ${usedStr} of ${capStr} free plan ${copy.label}.`,
    ...(kind === "blocked" ? [copy.pausedCopy] : []),
    cta,
    billingUrl,
  ].join("\n");

  const html = buildUsageQuotaHtml({
    kind,
    workspaceName,
    meterLabel: copy.label,
    pausedCopy: copy.pausedCopy,
    cta,
    usedStr,
    capStr,
    billingUrl,
  });

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

// Card layout mirrors the workspace-invite email (frontend/ui
// send-invite-email.ts): table-based markup with inline styles only, so it
// survives Gmail/Outlook CSS stripping.
function buildUsageQuotaHtml(params: {
  kind: "warning" | "blocked";
  workspaceName: string;
  meterLabel: string;
  pausedCopy: string;
  cta: string;
  usedStr: string;
  capStr: string;
  billingUrl: string;
}): string {
  const { kind, workspaceName, meterLabel, pausedCopy, cta, usedStr, capStr, billingUrl } = params;
  const safeWorkspaceName = escapeHtml(workspaceName);

  const title = kind === "warning" ? "Approaching your free plan limit" : "Free plan limit reached";
  const pausedSection =
    kind === "blocked"
      ? `
      <!-- Paused-feature callout -->
      <tr>
        <td style="padding: 0 40px 24px 40px;">
          <table cellpadding="0" cellspacing="0" border="0" width="100%" style="background-color: #fafafa; border: 1px solid #e5e5e5;">
            <tr>
              <td style="padding: 12px 16px;">
                <p style="margin: 0; color: #333; font-size: 14px; line-height: 1.6; text-align: center;">
                  <strong>${pausedCopy}</strong>
                </p>
              </td>
            </tr>
          </table>
        </td>
      </tr>`
      : "";

  return `
<!DOCTYPE html>
<html>
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
  </head>
  <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; color: #333; margin: 0; padding: 20px; background-color: #fafafa;">
    <table cellpadding="0" cellspacing="0" border="0" width="100%" style="max-width: 480px; margin: 0 auto; background: #fff; border: 1px solid #e5e5e5;">
      <!-- Logo section -->
      <tr>
        <td style="padding: 40px 40px 32px 40px; text-align: center;">
          <img src="${LOGO_URL}" alt="TraceRoot" width="72" height="72" style="display: block; margin: 0 auto; border-radius: 14px;" />
        </td>
      </tr>

      <!-- Title -->
      <tr>
        <td style="padding: 0 40px 24px 40px; text-align: center;">
          <h1 style="font-size: 24px; font-weight: 600; margin: 0; color: #000; letter-spacing: -0.5px;">
            ${title}
          </h1>
        </td>
      </tr>

      <!-- Body -->
      <tr>
        <td style="padding: 0 40px 24px 40px;">
          <p style="margin: 0; color: #333; font-size: 15px; line-height: 1.6; text-align: center;">
            <strong>${safeWorkspaceName}</strong> has used <strong>${usedStr}</strong> of <strong>${capStr}</strong> free plan ${meterLabel}.
          </p>
        </td>
      </tr>
${pausedSection}
      <!-- CTA note -->
      <tr>
        <td style="padding: 0 40px 32px 40px;">
          <p style="margin: 0; color: #333; font-size: 15px; line-height: 1.6; text-align: center;">
            ${cta}
          </p>
        </td>
      </tr>

      <!-- Button -->
      <tr>
        <td style="padding: 0 40px 40px 40px; text-align: center;">
          <table cellpadding="0" cellspacing="0" border="0" style="margin: 0 auto;">
            <tr>
              <td style="background-color: #000;">
                <a href="${billingUrl}" style="display: inline-block; padding: 10px 20px; color: #ffffff; text-decoration: none; font-weight: 500; font-size: 14px;">
                  Manage your plan
                </a>
              </td>
            </tr>
          </table>
        </td>
      </tr>

      <!-- Divider -->
      <tr>
        <td style="border-top: 1px solid #e5e5e5;"></td>
      </tr>

      <!-- Footer -->
      <tr>
        <td style="padding: 24px 40px; background-color: #fafafa;">
          <p style="color: #999; font-size: 12px; margin: 0; text-align: center;">
            You are receiving this because you are an admin of the ${safeWorkspaceName} workspace on TraceRoot.
          </p>
        </td>
      </tr>
    </table>
  </body>
</html>
  `.trim();
}
