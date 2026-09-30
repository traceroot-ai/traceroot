import { escapeHtml, renderEmailCard } from "@traceroot/core";
import { escapeMrkdwn, truncate, truncateEscaped } from "@traceroot/slack";
import type { DigestItem } from "./digest.js";

const APP_BASE_URL = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";

// Slack rejects a message with more than 50 blocks: header, one heading per
// section (three), the footer and a divider leave 44 for signal lines.
const MAX_SLACK_LINES = 44;
// Titles are model-written from detector output; bound them for one line.
const TITLE_CAP = 200;
const ROOT_CAUSE_CAP = 400;

const SECTIONS = [
  { kind: "new", heading: "New" },
  { kind: "reopened", heading: "Reopened" },
  { kind: "ongoing", heading: "Ongoing" },
] as const;

/** Link to the signal on its detector's page. */
export function signalUrl(
  projectId: string,
  item: Pick<DigestItem, "detectorId" | "signalId">,
): string {
  return (
    `${APP_BASE_URL}/projects/${encodeURIComponent(projectId)}` +
    `/detectors/${encodeURIComponent(item.detectorId)}?signal=${encodeURIComponent(item.signalId)}`
  );
}

function hitsText(item: DigestItem): string {
  const total = `${item.hitCount} ${item.hitCount === 1 ? "hit" : "hits"}`;
  return item.kind === "ongoing" ? `+${item.newHits} since the last digest (${total})` : total;
}

function rcaText(item: DigestItem): string | null {
  if (!item.rca) return null;
  if (item.rca.state === "done")
    return item.rca.rootCause ? `Root cause: ${item.rca.rootCause}` : null;
  return item.rca.state === "failed" ? "RCA failed" : "RCA still running";
}

export function digestHeadline(items: readonly DigestItem[], projectName: string): string {
  const parts = SECTIONS.map(({ kind, heading }) => {
    const n = items.filter((i) => i.kind === kind).length;
    return n ? `${n} ${heading.toLowerCase()}` : null;
  }).filter(Boolean);
  return `Signals in ${projectName}: ${parts.join(", ")}`;
}

/** Slack blocks: one section per kind, one line per signal. Model-written text is escaped. */
export function buildSignalDigestBlocks(params: {
  projectId: string;
  projectName: string;
  items: readonly DigestItem[];
}): unknown[] {
  const blocks: unknown[] = [
    {
      type: "header",
      text: {
        type: "plain_text",
        text: truncate(digestHeadline(params.items, params.projectName), 150),
      },
    },
  ];
  let lines = 0;
  let omitted = 0;
  for (const { kind, heading } of SECTIONS) {
    const section = params.items.filter((i) => i.kind === kind);
    if (section.length === 0) continue;
    blocks.push({ type: "section", text: { type: "mrkdwn", text: `*${heading}*` } });
    for (const item of section) {
      if (lines >= MAX_SLACK_LINES) {
        omitted++;
        continue;
      }
      lines++;
      const title = truncateEscaped(escapeMrkdwn(item.title), TITLE_CAP);
      const detector = truncateEscaped(escapeMrkdwn(item.detectorName), TITLE_CAP);
      const rca = rcaText(item);
      const text =
        `*<${signalUrl(params.projectId, item)}|${title}>* · ${detector} · ${hitsText(item)}` +
        (rca ? `\n>${truncateEscaped(escapeMrkdwn(rca), ROOT_CAUSE_CAP)}` : "");
      blocks.push({ type: "section", text: { type: "mrkdwn", text: truncate(text) } });
    }
  }
  if (omitted > 0) {
    blocks.push({
      type: "context",
      elements: [{ type: "mrkdwn", text: `+${omitted} more signal${omitted === 1 ? "" : "s"}` }],
    });
  }
  blocks.push({ type: "divider" });
  return blocks;
}

/** Email subject, text and HTML for the same digest. */
export function buildSignalDigestEmail(params: {
  projectId: string;
  projectName: string;
  items: readonly DigestItem[];
}): { subject: string; text: string; html: string } {
  const headline = digestHeadline(params.items, params.projectName);
  const text: string[] = [headline, ""];
  const htmlSections: string[] = [];
  for (const { kind, heading } of SECTIONS) {
    const section = params.items.filter((i) => i.kind === kind);
    if (section.length === 0) continue;
    text.push(`${heading}:`);
    const rows = section.map((item) => {
      const rca = rcaText(item);
      text.push(`- ${item.title} · ${item.detectorName} · ${hitsText(item)}`);
      if (rca) text.push(`  ${rca}`);
      text.push(`  ${signalUrl(params.projectId, item)}`);
      return (
        `<p style="margin: 6px 0; color: #333; font-size: 14px; line-height: 1.6;">` +
        `<a href="${signalUrl(params.projectId, item)}" style="color: #000; font-weight: 500;">${escapeHtml(item.title)}</a>` +
        ` <span style="color: #888;">· ${escapeHtml(item.detectorName)} · ${escapeHtml(hitsText(item))}</span>` +
        (rca
          ? `<br/><span style="color: #555;">${escapeHtml(rca.slice(0, ROOT_CAUSE_CAP))}</span>`
          : "") +
        `</p>`
      );
    });
    text.push("");
    htmlSections.push(
      `<p style="margin: 12px 0 4px 0; color: #000; font-size: 13px; font-weight: 600;">${heading}</p>` +
        rows.join("\n"),
    );
  }
  const safeProject = escapeHtml(params.projectName);
  const html = renderEmailCard({
    title: "Signals update",
    bodyHtml: `
      <tr>
        <td style="padding: 0 40px 16px 40px; text-align: center;">
          <p style="margin: 0; color: #333; font-size: 15px; line-height: 1.6;">${escapeHtml(headline)}</p>
        </td>
      </tr>
      <tr>
        <td style="padding: 0 40px 32px 40px;">
          <table cellpadding="0" cellspacing="0" border="0" width="100%" style="background-color: #fafafa; border: 1px solid #e5e5e5;">
            <tr><td style="padding: 12px 16px;">
${htmlSections.join("\n")}
            </td></tr>
          </table>
        </td>
      </tr>`,
    buttonLabel: "View detectors",
    buttonUrl: `${APP_BASE_URL}/projects/${encodeURIComponent(params.projectId)}/detectors`,
    footerText: `You are receiving this because detector alerts are enabled for the ${safeProject} project on TraceRoot.`,
  });
  return { subject: `[TraceRoot] ${headline}`, text: text.join("\n"), html };
}
