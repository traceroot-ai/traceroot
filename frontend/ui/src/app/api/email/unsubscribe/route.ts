// Product-email opt-out. No session: the signed token in `t` is the credential.
// GET only verifies the token and renders the form; it never writes (link scanners fetch it).
// POST takes the page form or an RFC 8058 one-click body. An invalid token on POST
// answers 200 with an empty body so a stale one-click never errors in a mail client; it is
// logged, since a burst of them means the signing secret was rotated out.
import { escapeHtml } from "@traceroot/core";
import {
  UNSUBSCRIBE_PATH,
  verifyUnsubscribeToken,
  type TopicSubscription,
} from "@traceroot/core/email";
import { emailChoiceTime, recordUnsubscribe, type EmailPreference } from "@/lib/lifecycle/pause";
import {
  setProviderTopic,
  syncEmailPreference,
  type SyncResult,
} from "@/lib/lifecycle/email-preference-sync";

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
  if (!check.valid) {
    console.warn("[unsubscribe] invalid token on POST, nothing recorded");
    return new Response(null, { status: 200, headers: HTML_HEADERS });
  }

  const failed = () =>
    html(
      "<p>Could not update your preference right now. Please try again in a moment, or reply to the email and we'll do it by hand.</p>",
      502,
    );
  const subscribed = action === "opt_in";
  // The account holds the person's choice and decides; the provider follows it.
  // 1. Record the choice on the account, stamped with when it was made by the
  //    database's clock, so it orders the same whichever web server takes the
  //    request. Only a choice newer than the latest one applied takes effect
  //    (pause.ts). If this fails, nothing has changed anywhere: an error answer.
  // 2. Bring the provider in line with the choice now in force. If that does not
  //    finish, the choice is already kept, and the scheduled run completes the
  //    sync (email-preference-sync.ts): nobody has to try again.
  let preference: EmailPreference | null;
  try {
    preference = await recordUnsubscribe(check.email, subscribed, await emailChoiceTime());
  } catch (error) {
    console.error("[unsubscribe] %s not recorded on the account: %s", action, String(error));
    return failed();
  }
  let result: SyncResult | null = null;
  if (preference) {
    result = await syncEmailPreference(preference.userId, check.email).catch(
      (): SyncResult => ({ state: "unknown" }),
    );
  } else if ((await setProviderTopic(check.email, action)) !== "ok") {
    // No account to keep the choice on: the provider is the only place, so ask
    // for another try.
    return failed();
  }
  // The address stays out of the log.
  console.log(
    "[unsubscribe] %s %s%s",
    action,
    preference && !preference.applied ? "ignored, a newer choice is in force" : "recorded",
    `${preference ? ` for user ${preference.userId}` : ""}${result && result.state !== "applied" ? `, provider ${result.state}` : ""}`,
  );

  // What to tell the person: the choice that will hold, not just the one asked for.
  // - An unsubscribe on the account always holds: the provider follows it.
  // - A Subscribe again holds once the provider took it, or once the scheduled
  //   run resends one the provider refused.
  // - A Subscribe again that raced another write, or got no answer, is not
  //   promised either way (it may hold, or the scheduled run may keep an
  //   opt-out over it); the page says so neutrally and offers the choice again.
  const email = escapeHtml(check.email);
  const subscribeAgain = form(token, "opt_in", "Subscribe again");
  const later = "<p>It can take a few minutes to apply everywhere.</p>";
  const inForce = preference ? preference.subscribed : subscribed;
  let message: string;
  if (!inForce || (result?.state === "applied" && !result.subscribed)) {
    message = `<p>You're unsubscribed. No more product emails will be sent to ${email}.</p>${subscribeAgain}${result && result.state !== "applied" ? later : ""}`;
  } else if (!result || result.state === "applied") {
    message = "<p>You're subscribed again.</p>";
  } else if (result.state === "superseded") {
    message = `<p>You're subscribed again.</p>${later}`;
  } else if (result.state === "rejected") {
    message = `<p>You're subscribed again.</p>${later}`;
  } else if (result.state === "queued") {
    message = `<p>Another change to your email preferences is still being applied, so we couldn't confirm this one yet. Choose Subscribe again to try once more.</p>${subscribeAgain}`;
  } else {
    message = `<p>We couldn't confirm this with our email service, so it may not have gone through. Choose Subscribe again to try once more.</p>${subscribeAgain}`;
  }
  return html(`${message}${NOTE}`);
}
