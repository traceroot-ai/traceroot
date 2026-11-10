import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sendMail = vi.fn();
const createTransport = vi.fn(() => ({ sendMail }));

vi.mock("nodemailer", () => ({
  default: { createTransport: () => createTransport() },
}));

const baseParams = {
  to: ["a@example.com"],
  projectId: "p1",
  projectName: "billing",
  windowStart: new Date("2026-06-24T14:00:00Z"),
  windowEnd: new Date("2026-06-24T15:00:00Z"),
  total: 3,
  entries: [
    {
      detectorId: "d1",
      detectorName: "Hallucination",
      findingCount: 2,
      latestTraceId: "abcdef1234567890",
    },
    {
      detectorId: "d2",
      detectorName: "Latency spike",
      findingCount: 1,
      latestTraceId: "0011223344556677",
    },
  ],
};

// Byte-for-byte capture of the email produced for baseParams (HTML re-captured
// after the brand refresh of the shared card; text unchanged since before the
// optional summary paragraph existed). formatWindowRange pins
// its formatting to UTC, so this is stable across machines and timezones.
// Guards that an absent/blank summary leaves the email exactly as it shipped.
const PRE_CHANGE_BASELINE_TEXT =
  "3 findings in project billing.\nJun 24, 14:00–15:00 UTC · 2 detectors\n\n- Hallucination — 2 findings · latest abcdef12\n  https://app.example.com/projects/p1/detectors/d1?date_filter=custom&start=2026-06-24T14%3A00%3A00.000Z&end=2026-06-24T15%3A00%3A00.000Z\n- Latency spike — 1 finding · latest 00112233\n  https://app.example.com/projects/p1/detectors/d2?date_filter=custom&start=2026-06-24T14%3A00%3A00.000Z&end=2026-06-24T15%3A00%3A00.000Z";

const PRE_CHANGE_BASELINE_HTML =
  '<!DOCTYPE html>\n<html>\n  <head>\n    <meta charset="utf-8">\n    <meta name="viewport" content="width=device-width, initial-scale=1.0">\n  </head>\n  <body style="font-family: Geist, -apple-system, BlinkMacSystemFont, \'Segoe UI\', Roboto, Helvetica, Arial, sans-serif; line-height: 1.6; color: #0B1015; margin: 0; padding: 32px 16px; background-color: #F4F4F6;">\n    <table cellpadding="0" cellspacing="0" border="0" width="100%" style="max-width: 560px; margin: 0 auto; background: #FFFFFF; border: 1px solid #DFDFDF; border-top: 3px solid #14B8B0; border-radius: 8px; border-collapse: separate;">\n      <!-- Logo section -->\n      <tr>\n        <td style="padding: 32px 40px 0 40px;">\n          <img src="https://raw.githubusercontent.com/traceroot-ai/traceroot/main/frontend/ui/public/images/traceroot_wordmark.png" alt="TraceRoot" width="127" height="24" style="display: block; border: 0; height: 24px; width: 127px;" />\n        </td>\n      </tr>\n\n      <!-- Title -->\n      <tr>\n        <td style="padding: 32px 40px 16px 40px;">\n          <h1 style="font-size: 22px; line-height: 1.3; font-weight: 600; margin: 0; color: #0B1015; letter-spacing: -0.4px;">\n            New detector findings\n          </h1>\n        </td>\n      </tr>\n\n      <!-- Body -->\n      <tr>\n        <td style="padding: 0 40px 4px 40px;">\n          <p style="margin: 0; color: #0B1015; font-size: 15px; line-height: 1.6;">\n            <strong>3 findings</strong> in project <strong>billing</strong>.\n          </p>\n        </td>\n      </tr>\n\n      <!-- Window subline -->\n      <tr>\n        <td style="padding: 0 40px 24px 40px;">\n          <p style="margin: 0; color: #5F646B; font-size: 13px;">Jun 24, 14:00–15:00 UTC · 2 detectors</p>\n        </td>\n      </tr>\n\n      <!-- Per-detector rows -->\n      <tr>\n        <td style="padding: 0 40px 32px 40px;">\n          <table cellpadding="0" cellspacing="0" border="0" width="100%" style="border: 1px solid #DFDFDF; border-radius: 6px; border-collapse: separate;">\n<tr>\n              <td style="padding: 12px 16px;  font-size: 14px; line-height: 1.5;"><a href="https://app.example.com/projects/p1/detectors/d1?date_filter=custom&start=2026-06-24T14%3A00%3A00.000Z&end=2026-06-24T15%3A00%3A00.000Z" style="color: #0B1015; font-weight: 600; text-decoration: none;">Hallucination</a><br/><span style="color: #5F646B; font-size: 12px;">Latest trace <a href="https://app.example.com/projects/p1/traces?traceId=abcdef1234567890" style="color: #5F646B; font-family: \'Geist Mono\', SFMono-Regular, Menlo, Consolas, monospace;">abcdef12</a></span></td>\n              <td align="right" style="padding: 12px 16px;  white-space: nowrap; vertical-align: top; font-size: 14px; line-height: 1.5;"><strong style="color: #0B1015;">2</strong> <span style="color: #5F646B;">findings</span></td>\n            </tr>\n<tr>\n              <td style="padding: 12px 16px; border-top: 1px solid #DFDFDF; font-size: 14px; line-height: 1.5;"><a href="https://app.example.com/projects/p1/detectors/d2?date_filter=custom&start=2026-06-24T14%3A00%3A00.000Z&end=2026-06-24T15%3A00%3A00.000Z" style="color: #0B1015; font-weight: 600; text-decoration: none;">Latency spike</a><br/><span style="color: #5F646B; font-size: 12px;">Latest trace <a href="https://app.example.com/projects/p1/traces?traceId=0011223344556677" style="color: #5F646B; font-family: \'Geist Mono\', SFMono-Regular, Menlo, Consolas, monospace;">00112233</a></span></td>\n              <td align="right" style="padding: 12px 16px; border-top: 1px solid #DFDFDF; white-space: nowrap; vertical-align: top; font-size: 14px; line-height: 1.5;"><strong style="color: #0B1015;">1</strong> <span style="color: #5F646B;">finding</span></td>\n            </tr>\n          </table>\n        </td>\n      </tr>\n      <!-- Button -->\n      <tr>\n        <td style="padding: 0 40px 36px 40px;">\n          <table cellpadding="0" cellspacing="0" border="0">\n            <tr>\n              <td style="background-color: #0B1015; border-radius: 6px;">\n                <a href="https://app.example.com/projects/p1/detectors" style="display: inline-block; padding: 11px 20px; color: #FFFFFF; text-decoration: none; font-weight: 500; font-size: 14px; border-radius: 6px;">\n                  View findings\n                </a>\n              </td>\n            </tr>\n          </table>\n        </td>\n      </tr>\n\n      <!-- Divider -->\n      <tr>\n        <td style="border-top: 1px solid #DFDFDF;"></td>\n      </tr>\n\n      <!-- Footer -->\n      <tr>\n        <td style="padding: 20px 40px 24px 40px;">\n          <p style="color: #5F646B; font-size: 12px; line-height: 1.6; margin: 0;">\n            You are receiving this because detector email alerts are enabled for the billing project on TraceRoot.\n          </p>\n          <p style="color: #5F646B; font-size: 12px; line-height: 1.6; margin: 8px 0 0 0;">\n            TraceRoot &middot; <a href="https://traceroot.ai" style="color: #5F646B; text-decoration: underline;">traceroot.ai</a>\n          </p>\n        </td>\n      </tr>\n    </table>\n  </body>\n</html>';

describe("sendDigestAlertEmail", () => {
  // The baseline embeds the default wordmark URL; NEXT_PUBLIC_LOGO_URL would
  // override it, so clear it for these tests and restore it afterwards.
  const savedLogoUrl = process.env.NEXT_PUBLIC_LOGO_URL;

  beforeEach(() => {
    vi.resetModules();
    delete process.env.NEXT_PUBLIC_LOGO_URL;
    sendMail.mockReset();
    sendMail.mockResolvedValue(undefined);
    createTransport.mockClear();
    process.env.TRACEROOT_SMTP_URL = "smtp://user:pass@localhost:587";
    process.env.NEXT_PUBLIC_APP_URL = "https://app.example.com";
  });

  afterEach(() => {
    delete process.env.TRACEROOT_SMTP_URL;
    delete process.env.NEXT_PUBLIC_APP_URL;
    if (savedLogoUrl === undefined) delete process.env.NEXT_PUBLIC_LOGO_URL;
    else process.env.NEXT_PUBLIC_LOGO_URL = savedLogoUrl;
  });

  it("sends a digest email with subject, window-filtered deep-links, and subline", async () => {
    const { sendDigestAlertEmail } = await import("../email.js");
    await sendDigestAlertEmail(baseParams);

    expect(sendMail).toHaveBeenCalledTimes(1);
    const mail = sendMail.mock.calls[0][0];

    expect(mail.subject).toBe("[TraceRoot Alert] 3 findings — billing");
    expect(mail.to).toBe("a@example.com");

    // each detector name present
    expect(mail.html).toContain("Hallucination");
    expect(mail.html).toContain("Latency spike");

    // window-filtered deep-link (verbatim filter prefix + same shape as slack)
    expect(mail.html).toContain(
      "https://app.example.com/projects/p1/detectors/d1?date_filter=custom&start=",
    );
    expect(mail.html).toContain(encodeURIComponent("2026-06-24T14:00:00.000Z"));

    // subline with detector count
    expect(mail.html).toContain("· 2 detectors");

    // plain-text twin lists each detector
    expect(mail.text).toContain("- Hallucination — 2 findings");
    expect(mail.text).toContain("- Latency spike — 1 finding");
  });

  it("early-returns without sending when the recipient list is empty", async () => {
    const { sendDigestAlertEmail } = await import("../email.js");
    await sendDigestAlertEmail({ ...baseParams, to: [] });

    expect(sendMail).not.toHaveBeenCalled();
  });

  it("early-returns without sending when SMTP is not configured", async () => {
    delete process.env.TRACEROOT_SMTP_URL;
    const { sendDigestAlertEmail } = await import("../email.js");
    await sendDigestAlertEmail(baseParams);

    expect(sendMail).not.toHaveBeenCalled();
  });

  it("caps the listed detectors and adds an overflow row (mirrors the Slack digest)", async () => {
    const { sendDigestAlertEmail } = await import("../email.js");
    const entries = Array.from({ length: 50 }, (_, i) => ({
      detectorId: `d${i}`,
      detectorName: `Detector ${i}`,
      findingCount: 1,
      latestTraceId: "",
    }));
    await sendDigestAlertEmail({ ...baseParams, total: 50, entries });

    const mail = sendMail.mock.calls[0][0];
    // 45 rows listed, the rest folded into the overflow note
    expect(mail.html).toContain("Detector 44");
    expect(mail.html).not.toContain("Detector 45");
    expect(mail.html).toContain("+5 more detectors");
    expect(mail.text).toContain("+5 more detectors");
    // the subline still counts every triggered detector
    expect(mail.html).toContain("· 50 detectors");
  });

  it("escapes HTML in detector names and displayed trace ids", async () => {
    const { sendDigestAlertEmail } = await import("../email.js");
    await sendDigestAlertEmail({
      ...baseParams,
      entries: [
        {
          detectorId: "d1",
          detectorName: `<b>Bold</b> & co`,
          findingCount: 1,
          latestTraceId: `<script>7890`,
        },
      ],
    });

    const mail = sendMail.mock.calls[0][0];
    expect(mail.html).not.toContain("<b>Bold</b>");
    expect(mail.html).toContain("&lt;b&gt;Bold&lt;/b&gt; &amp; co");
    // the displayed prefix is the first 8 chars ("<script>"), escaped
    expect(mail.html).not.toContain("<script>");
    expect(mail.html).toContain("&lt;script&gt;");
  });

  it("omits the latest-trace segment when an entry has no latest trace", async () => {
    const { sendDigestAlertEmail } = await import("../email.js");
    await sendDigestAlertEmail({
      ...baseParams,
      entries: [
        { detectorId: "d1", detectorName: "Hallucination", findingCount: 2, latestTraceId: "" },
      ],
    });

    const mail = sendMail.mock.calls[0][0];
    expect(mail.html).toContain("Hallucination");
    expect(mail.html).not.toContain("latest");
    expect(mail.html).not.toContain('href=""');
    expect(mail.text).not.toContain("latest");
  });

  it("renders the summary paragraph in text and html, escaped and capped", async () => {
    const { sendDigestAlertEmail } = await import("../email.js");
    await sendDigestAlertEmail({
      ...baseParams,
      summary: 'Payments <b>"charge"</b> failing & retrying.',
    });
    const mail = sendMail.mock.calls[0][0];
    expect(mail.text).toContain('Payments <b>"charge"</b> failing & retrying.'); // text body: verbatim
    expect(mail.html).toContain("Payments &lt;b&gt;"); // html: escaped
    expect(mail.html).not.toContain('<b>"charge"</b>');
  });

  it("caps an over-long summary at the render cap with an ellipsis", async () => {
    const { sendDigestAlertEmail } = await import("../email.js");
    const { DIGEST_SUMMARY_RENDER_CAP: CAP } = await import("@traceroot/slack");
    await sendDigestAlertEmail({ ...baseParams, summary: "a".repeat(CAP + 100) });
    const mail = sendMail.mock.calls[0][0];
    // CAP-1 chars + "…" = CAP total
    expect(mail.text).toContain("a".repeat(CAP - 1) + "…");
    expect(mail.text).not.toContain("a".repeat(CAP));
    expect(mail.html).toContain("a".repeat(CAP - 1) + "…");
    expect(mail.html).not.toContain("a".repeat(CAP));
  });

  it("is byte-identical to today when summary is absent", async () => {
    const { sendDigestAlertEmail } = await import("../email.js");
    await sendDigestAlertEmail({ ...baseParams });
    const without = sendMail.mock.calls[0][0];
    sendMail.mockClear();
    await sendDigestAlertEmail({ ...baseParams, summary: "  " });
    const blank = sendMail.mock.calls[0][0];
    expect(blank.html).toBe(without.html);
    expect(blank.text).toBe(without.text);
    // New-vs-OLD: also compare against the pre-change capture, so a template
    // regression can't hide behind a blank-vs-absent equality that would still
    // hold if both outputs drifted together.
    expect(without.html).toBe(PRE_CHANGE_BASELINE_HTML);
    expect(without.text).toBe(PRE_CHANGE_BASELINE_TEXT);
  });
});
