import { escapeHtml } from "@traceroot/core";
import type { UpdateResult } from "@traceroot/core/updates";
import { escapeMrkdwn, formatWindowRange, truncateEscaped } from "@traceroot/slack";

/**
 * Slack and email are two renderings of one structured result, so the numbers
 * in the two are the same text. Nothing is added here that the result does not
 * contain, except the project name, the window and a link back to the app.
 */

export interface RenderContext {
  appBaseUrl: string;
  projectId: string;
  projectName: string;
  windowStart: Date;
  windowEnd: Date;
  frequency: "daily" | "weekly";
}

export interface SlackPost {
  text: string;
  blocks: unknown[];
}

export interface SlackRendering {
  headline: SlackPost;
  /** Posted under the headline, in order. */
  thread: SlackPost[];
}

// Slack allows 50 blocks and 3000 characters per text; stay well inside both.
const THREAD_BLOCK_LIMIT = 40;
const TEXT_LIMIT = 2800;

const projectUrl = (ctx: RenderContext) =>
  `${ctx.appBaseUrl.replace(/\/+$/, "")}/projects/${encodeURIComponent(ctx.projectId)}`;

const clip = (text: string, max: number) =>
  text.length <= max ? text : `${text.slice(0, max - 1)}…`;

/** A slack link needs its label and url free of the characters that end it. */
const slackLink = (url: string, label: string) =>
  `<${url.replace(/[<>|]/g, "")}|${escapeMrkdwn(label).replace(/\|/g, "/")}>`;

export function renderSlack(result: UpdateResult, ctx: RenderContext): SlackRendering {
  const window = formatWindowRange(ctx.windowStart, ctx.windowEnd);
  const headlineText = `${ctx.projectName}: ${result.headline}`;
  const headline: SlackPost = {
    text: clip(headlineText, 300),
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: truncateEscaped(
            `*${escapeMrkdwn(ctx.projectName)}*\n${escapeMrkdwn(result.headline)}`,
            TEXT_LIMIT,
          ),
        },
      },
      {
        type: "context",
        elements: [
          {
            type: "mrkdwn",
            text: `${ctx.frequency === "daily" ? "Daily" : "Weekly"} update · ${escapeMrkdwn(window)} · ${slackLink(projectUrl(ctx), "Open in TraceRoot")}`,
          },
        ],
      },
    ],
  };

  const blocks: unknown[] = [];
  if (result.summary.trim() !== "") {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: truncateEscaped(escapeMrkdwn(result.summary), TEXT_LIMIT) },
    });
  }
  for (const section of result.sections) {
    if (section.items.length === 0) continue;
    blocks.push({ type: "header", text: { type: "plain_text", text: clip(section.title, 150) } });
    for (const item of section.items) {
      const links = item.evidence.map((e) => slackLink(e.url, e.label)).join("  ");
      blocks.push({
        type: "section",
        text: {
          type: "mrkdwn",
          text: truncateEscaped(`• ${escapeMrkdwn(item.text)}\n${links}`, TEXT_LIMIT),
        },
      });
    }
  }
  if (result.suggestedDetectors.length > 0) {
    blocks.push({ type: "header", text: { type: "plain_text", text: "Suggested detectors" } });
    for (const d of result.suggestedDetectors) {
      blocks.push({
        type: "section",
        text: {
          type: "mrkdwn",
          text: truncateEscaped(
            `• *${escapeMrkdwn(d.name)}*: ${escapeMrkdwn(d.checks)}`,
            TEXT_LIMIT,
          ),
        },
      });
    }
  }

  const thread: SlackPost[] = [];
  for (let i = 0; i < blocks.length; i += THREAD_BLOCK_LIMIT) {
    thread.push({ text: "Update details", blocks: blocks.slice(i, i + THREAD_BLOCK_LIMIT) });
  }
  return { headline, thread };
}

export interface EmailRendering {
  subject: string;
  text: string;
  html: string;
}

export function renderEmail(result: UpdateResult, ctx: RenderContext): EmailRendering {
  const window = formatWindowRange(ctx.windowStart, ctx.windowEnd);
  const kind = ctx.frequency === "daily" ? "Daily" : "Weekly";
  const subject = clip(`${ctx.projectName}: ${result.headline}`, 200);
  const link = projectUrl(ctx);

  const textLines: string[] = [
    result.headline,
    "",
    `${kind} update for ${ctx.projectName} · ${window}`,
    "",
  ];
  if (result.summary.trim() !== "") textLines.push(result.summary, "");
  for (const section of result.sections) {
    if (section.items.length === 0) continue;
    textLines.push(section.title.toUpperCase());
    for (const item of section.items) {
      textLines.push(`- ${item.text}`);
      for (const e of item.evidence) textLines.push(`  ${e.label}: ${e.url}`);
    }
    textLines.push("");
  }
  if (result.suggestedDetectors.length > 0) {
    textLines.push("SUGGESTED DETECTORS");
    for (const d of result.suggestedDetectors) textLines.push(`- ${d.name}: ${d.checks}`);
    textLines.push("");
  }
  textLines.push(`Open in TraceRoot: ${link}`);

  const sections = result.sections
    .filter((s) => s.items.length > 0)
    .map(
      (section) => `
      <h2 style="font-size:16px;margin:24px 0 8px 0;color:#111;">${escapeHtml(section.title)}</h2>
      <ul style="padding-left:20px;margin:0;">${section.items
        .map(
          (item) => `
        <li style="margin:0 0 10px 0;">${escapeHtml(item.text)}<br>${item.evidence
          .map(
            (e) =>
              `<a href="${escapeHtml(e.url)}" style="color:#0b57d0;font-size:13px;margin-right:12px;">${escapeHtml(e.label)}</a>`,
          )
          .join("")}</li>`,
        )
        .join("")}</ul>`,
    )
    .join("");
  const detectors =
    result.suggestedDetectors.length > 0
      ? `<h2 style="font-size:16px;margin:24px 0 8px 0;color:#111;">Suggested detectors</h2><ul style="padding-left:20px;margin:0;">${result.suggestedDetectors
          .map(
            (d) =>
              `<li style="margin:0 0 6px 0;"><strong>${escapeHtml(d.name)}</strong>: ${escapeHtml(d.checks)}</li>`,
          )
          .join("")}</ul>`
      : "";

  const html = `<!DOCTYPE html>
<html>
  <head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
  <body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;line-height:1.55;color:#333;margin:0;padding:20px;background:#fafafa;">
    <table cellpadding="0" cellspacing="0" border="0" width="100%" style="max-width:640px;margin:0 auto;background:#fff;border:1px solid #e5e5e5;">
      <tr><td style="padding:28px 32px;">
        <div style="font-size:13px;color:#777;">${kind} update · ${escapeHtml(ctx.projectName)} · ${escapeHtml(window)}</div>
        <h1 style="font-size:22px;margin:8px 0 16px 0;color:#000;">${escapeHtml(result.headline)}</h1>
        ${result.summary.trim() !== "" ? `<p style="margin:0 0 8px 0;">${escapeHtml(result.summary)}</p>` : ""}
        ${sections}
        ${detectors}
        <p style="margin:28px 0 0 0;"><a href="${escapeHtml(link)}" style="background:#111;color:#fff;padding:10px 18px;text-decoration:none;border-radius:4px;display:inline-block;">Open in TraceRoot</a></p>
        <p style="margin:24px 0 0 0;font-size:12px;color:#888;">You get this because email is turned on for ${escapeHtml(ctx.projectName)}'s updates.</p>
      </td></tr>
    </table>
  </body>
</html>`;
  return { subject, text: textLines.join("\n"), html };
}
