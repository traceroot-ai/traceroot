import nodemailer from "nodemailer";
import {
  detectorFindingsUrl,
  formatWindowRange,
  traceUrl,
  type DigestEntry,
} from "@traceroot/slack";
import { escapeHtml, renderEmailCard, type UsageMeter } from "@traceroot/core";

const SMTP_URL = process.env.TRACEROOT_SMTP_URL;
const SMTP_FROM = process.env.TRACEROOT_SMTP_MAIL_FROM || "noreply@traceroot.ai";
const APP_BASE_URL = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";

// Mirror the Slack digest's overflow behavior (its 50-block ceiling caps it at
// 45 detector lines): list at most this many per-detector rows so a project
// with many triggered detectors can't produce an unwieldy email — Gmail clips
// messages over ~102 KB. An overflow row names how many were omitted, and the
// View-findings button leads to the full list.
const MAX_DIGEST_ROWS = 45;

function createTransport() {
  if (!SMTP_URL) return null;
  const url = new URL(SMTP_URL);
  // smtps:// means implicit TLS (default port 465); smtp:// means plaintext /
  // STARTTLS (default 587). An explicit port always wins, and port 465
  // implies implicit TLS regardless of scheme.
  const secureScheme = url.protocol === "smtps:";
  const port = parseInt(url.port) || (secureScheme ? 465 : 587);
  return nodemailer.createTransport({
    host: url.hostname,
    port,
    secure: secureScheme || port === 465,
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

  const shown = entries.slice(0, MAX_DIGEST_ROWS);
  const omitted = entries.length - shown.length;

  const textParts = [
    `${total} ${noun} in project ${projectName}.`,
    `${windowRange} · ${entries.length} detector${entries.length === 1 ? "" : "s"}`,
    ``,
  ];
  for (const e of shown) {
    const findingNoun = e.findingCount === 1 ? "finding" : "findings";
    // Omit the trace segment when there is no latest trace (mirrors the Slack
    // builder), so we never emit a blank/broken trace link.
    const latest = e.latestTraceId ? ` · latest ${e.latestTraceId.slice(0, 8)}` : "";
    textParts.push(
      `- ${e.detectorName} — ${e.findingCount} ${findingNoun}${latest}`,
      `  ${findingsUrlFor(e.detectorId)}`,
    );
  }
  if (omitted > 0) textParts.push(`+${omitted} more detector${omitted === 1 ? "" : "s"}`);

  const htmlRows = shown
    .map((e) => {
      const findingNoun = e.findingCount === 1 ? "finding" : "findings";
      // Trace IDs come from SDK-submitted telemetry, so escape the displayed
      // prefix like the detector name; the href is already URL-encoded.
      const latest = e.latestTraceId
        ? ` · latest <a href="${traceUrlFor(e.latestTraceId)}" style="color: #888;">${escapeHtml(e.latestTraceId.slice(0, 8))}</a>`
        : "";
      return `<p style="margin: 6px 0; color: #333; font-size: 14px; line-height: 1.6;"><a href="${findingsUrlFor(e.detectorId)}" style="color: #000; font-weight: 500;">${escapeHtml(e.detectorName)}</a> <span style="color: #888;">— ${e.findingCount} ${findingNoun}${latest}</span></p>`;
    })
    .concat(
      omitted > 0
        ? [
            `<p style="margin: 6px 0; color: #888; font-size: 14px; line-height: 1.6;">+${omitted} more detector${omitted === 1 ? "" : "s"}</p>`,
          ]
        : [],
    )
    .join("\n");

  const safeProjectName = escapeHtml(projectName);
  const html = renderEmailCard({
    title: "New detector findings",
    bodyHtml: `
      <!-- Body -->
      <tr>
        <td style="padding: 0 40px 8px 40px; text-align: center;">
          <p style="margin: 0; color: #333; font-size: 15px; line-height: 1.6;">
            <strong>${total} ${noun}</strong> in project <strong>${safeProjectName}</strong>.
          </p>
        </td>
      </tr>

      <!-- Window subline -->
      <tr>
        <td style="padding: 0 40px 24px 40px; text-align: center;">
          <p style="margin: 0; color: #888; font-size: 12px;">${windowRange} · ${entries.length} detector${entries.length === 1 ? "" : "s"}</p>
        </td>
      </tr>

      <!-- Per-detector rows -->
      <tr>
        <td style="padding: 0 40px 32px 40px;">
          <table cellpadding="0" cellspacing="0" border="0" width="100%" style="background-color: #fafafa; border: 1px solid #e5e5e5;">
            <tr>
              <td style="padding: 12px 16px;">
${htmlRows}
              </td>
            </tr>
          </table>
        </td>
      </tr>`,
    buttonLabel: "View findings",
    buttonUrl: `${APP_BASE_URL}/projects/${projectId}/detectors`,
    footerText: `You are receiving this because detector email alerts are enabled for the ${safeProjectName} project on TraceRoot.`,
  });

  await transport.sendMail({
    from: SMTP_FROM,
    to: params.to.join(", "),
    subject: `[TraceRoot Alert] ${total} ${noun} — ${projectName}`,
    text: textParts.join("\n"),
    html,
  });
}

// Copy for the free-plan usage-quota emails. The blocked line names exactly
// what paused — for the automatic meters (rca, detector) there is no
// interactive tell, so the email is the only signal the feature stopped —
// and the warning line names what WILL pause, so the 80% email carries the
// stakes, not just the numbers.
const USAGE_METER_COPY: Record<
  UsageMeter,
  { label: string; pausedCopy: string; willPauseCopy: string }
> = {
  events: {
    label: "events",
    pausedCopy: "Trace and span ingestion is paused — new telemetry is being dropped.",
    willPauseCopy:
      "Once the limit is reached, trace and span ingestion will pause and new telemetry will be dropped.",
  },
  rca: {
    label: "root-cause analysis runs",
    pausedCopy:
      "Automatic root-cause analysis is paused — new detector findings will not be analyzed.",
    willPauseCopy:
      "Once the limit is reached, automatic root-cause analysis will pause and new detector findings will not be analyzed.",
  },
  detector: {
    label: "detector runs",
    pausedCopy: "Detector scans are paused — incoming traces are no longer being scanned.",
    willPauseCopy:
      "Once the limit is reached, detector scans will pause and incoming traces will no longer be scanned.",
  },
};

/**
 * Send a free-plan usage-quota email (80% warning or 100% blocked) to
 * workspace admins. Returns true ONLY when the SMTP server accepted the
 * message for at least one recipient, so callers can stamp sent-state on
 * real sends and retry failures (no SMTP config, empty recipient list,
 * SMTP error, every recipient rejected) on the next billing run.
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

  // The blocked lead avoids "used X of Y": measured usage can exceed the cap
  // (blocking is enforced at billing-tick granularity), and "126 of 100"
  // reads like a bug to the recipient. The warning lead spells out percent
  // and remaining headroom so the reader doesn't have to do the math.
  // floor, not round: a 49,999/50,000 warning must not display "(100%)"
  const pctStr = `${Math.floor((used / cap) * 100)}%`;
  const remainingStr = Math.max(0, cap - used).toLocaleString("en-US");
  const lead =
    kind === "warning"
      ? `${workspaceName} has used ${usedStr} of ${capStr} free plan ${copy.label} (${pctStr}) — ${remainingStr} remaining.`
      : `${workspaceName} has reached its free plan limit of ${capStr} ${copy.label}.`;

  const consequence = kind === "warning" ? copy.willPauseCopy : copy.pausedCopy;
  const text = [lead, consequence, cta, billingUrl].join("\n");

  const html = buildUsageQuotaHtml({
    kind,
    workspaceName,
    meterLabel: copy.label,
    consequence,
    cta,
    usedStr,
    capStr,
    pctStr,
    remainingStr,
    billingUrl,
  });

  try {
    const info = await transport.sendMail({
      from: SMTP_FROM,
      to: params.to.join(", "),
      subject,
      text,
      html,
    });
    if (info?.rejected?.length) {
      console.warn(
        `[Billing] Some recipients rejected for usage ${kind} email, workspace ${workspaceId} (${meter}):`,
        info.rejected,
      );
    }
    // Stamp only if at least one admin actually accepted delivery; a full
    // rejection must return false so the next billing run retries.
    return (info?.accepted?.length ?? 0) > 0;
  } catch (error) {
    console.error(
      `[Billing] Failed to send usage ${kind} email for workspace ${workspaceId} (${meter}):`,
      error,
    );
    return false;
  }
}

function buildUsageQuotaHtml(params: {
  kind: "warning" | "blocked";
  workspaceName: string;
  meterLabel: string;
  consequence: string;
  cta: string;
  usedStr: string;
  capStr: string;
  pctStr: string;
  remainingStr: string;
  billingUrl: string;
}): string {
  const {
    kind,
    workspaceName,
    meterLabel,
    consequence,
    cta,
    usedStr,
    capStr,
    pctStr,
    remainingStr,
    billingUrl,
  } = params;
  const safeWorkspaceName = escapeHtml(workspaceName);

  const title = kind === "warning" ? "Approaching your free plan limit" : "Free plan limit reached";
  return renderEmailCard({
    title,
    bodyHtml: `
      <!-- Body -->
      <tr>
        <td style="padding: 0 40px 24px 40px;">
          <p style="margin: 0; color: #333; font-size: 15px; line-height: 1.6; text-align: center;">
            ${
              kind === "warning"
                ? `<strong>${safeWorkspaceName}</strong> has used <strong>${usedStr}</strong> of <strong>${capStr}</strong> free plan ${meterLabel} (${pctStr}) — ${remainingStr} remaining.`
                : `<strong>${safeWorkspaceName}</strong> has reached its free plan limit of <strong>${capStr}</strong> ${meterLabel}.`
            }
          </p>
        </td>
      </tr>

      <!-- Consequence callout: what IS paused (blocked, bold) or what WILL
           pause at the limit (warning, regular weight). -->
      <tr>
        <td style="padding: 0 40px 24px 40px;">
          <table cellpadding="0" cellspacing="0" border="0" width="100%" style="background-color: #fafafa; border: 1px solid #e5e5e5;">
            <tr>
              <td style="padding: 12px 16px;">
                <p style="margin: 0; color: #333; font-size: 14px; line-height: 1.6; text-align: center;">
                  ${kind === "blocked" ? `<strong>${consequence}</strong>` : consequence}
                </p>
              </td>
            </tr>
          </table>
        </td>
      </tr>

      <!-- CTA note -->
      <tr>
        <td style="padding: 0 40px 32px 40px;">
          <p style="margin: 0; color: #333; font-size: 15px; line-height: 1.6; text-align: center;">
            ${cta}
          </p>
        </td>
      </tr>`,
    buttonLabel: "Manage your plan",
    buttonUrl: billingUrl,
    footerText: `You are receiving this because you are an admin of the ${safeWorkspaceName} workspace on TraceRoot.`,
  });
}
