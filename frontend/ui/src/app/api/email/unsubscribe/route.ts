// Product-email opt-out. No session: the signed token in `t` is the credential.
// GET only verifies the token and renders the form; it never writes (link scanners fetch it).
// POST takes the page form or an RFC 8058 one-click body. An invalid token on POST
// answers 200 with an empty body so a stale one-click never errors in a mail client.
import { escapeHtml } from "@traceroot/core";
import {
  setTopicSubscription,
  UNSUBSCRIBE_PATH,
  ensureContact,
  verifyUnsubscribeToken,
  type TopicSubscription,
} from "@traceroot/core/email";

const HTML_HEADERS = {
  "Content-Type": "text/html; charset=utf-8",
  "Cache-Control": "no-store",
};

const NOTE =
  '<p style="font-size:14px;color:#555">Account email such as workspace invites and alerts is not affected.</p>';

function page(body: string): string {
  return [
    "<!doctype html>",
    '<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">',
    "<title>Product emails from TraceRoot</title></head>",
    '<body style="font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Helvetica,Arial,sans-serif;font-size:16px;line-height:1.5;color:#222;max-width:36rem;margin:3rem auto;padding:0 1rem">',
    '<h1 style="font-size:1.25rem">Product emails from TraceRoot</h1>',
    body,
    "</body></html>",
  ].join("\n");
}

function html(body: string, status = 200): Response {
  return new Response(page(body), { status, headers: HTML_HEADERS });
}

function form(token: string, action: TopicSubscription, label: string): string {
  return [
    `<form method="post" action="${UNSUBSCRIBE_PATH}">`,
    `<input type="hidden" name="t" value="${escapeHtml(token)}">`,
    `<input type="hidden" name="action" value="${action}">`,
    `<button type="submit" style="font:inherit;padding:0.5rem 1rem">${label}</button>`,
    "</form>",
  ].join("");
}

export async function GET(request: Request): Promise<Response> {
  const token = new URL(request.url).searchParams.get("t") ?? "";
  const check = token ? verifyUnsubscribeToken(token) : { valid: false as const };
  if (!check.valid) return html("<p>This unsubscribe link is not valid.</p>", 400);

  const email = escapeHtml(check.email);
  return html(
    `<p>Unsubscribe ${email} from product emails from TraceRoot?</p>${form(token, "opt_out", "Unsubscribe")}${NOTE}`,
  );
}

async function readForm(request: Request): Promise<URLSearchParams> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.includes("application/x-www-form-urlencoded")) return new URLSearchParams();
  const text = await request.text().catch(() => "");
  return new URLSearchParams(text);
}

export async function POST(request: Request): Promise<Response> {
  const query = new URL(request.url).searchParams;
  const body = await readForm(request);

  let action: TopicSubscription;
  let token: string;
  if (body.get("List-Unsubscribe") === "One-Click") {
    action = "opt_out";
    token = query.get("t") ?? "";
  } else {
    const requested = body.get("action");
    action = requested === "opt_in" ? "opt_in" : "opt_out";
    token = body.get("t") ?? query.get("t") ?? "";
  }

  const check = token ? verifyUnsubscribeToken(token) : { valid: false as const };
  if (!check.valid) return new Response(null, { status: 200, headers: HTML_HEADERS });

  // The topic choice lives on a contact record, so make sure one exists first.
  const contact = await ensureContact({ email: check.email });
  const updated = contact.ok ? await setTopicSubscription(check.email, action) : { ok: false };
  if (!updated.ok) {
    return html(
      "<p>Could not update your preference right now. Reply to the email and we'll do it by hand.</p>",
      502,
    );
  }

  console.log(`[unsubscribe] ${action} recorded for ${check.email}`);
  const email = escapeHtml(check.email);
  const message =
    action === "opt_out"
      ? `<p>You're unsubscribed. No more product emails will be sent to ${email}.</p>${form(token, "opt_in", "Subscribe again")}`
      : "<p>You're subscribed again.</p>";
  return html(`${message}${NOTE}`);
}
