const SECTION_LIMIT = 3000;

function escapeMrkdwn(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function mdLinksToSlack(text: string): string {
  return text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, "<$2|$1>");
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
