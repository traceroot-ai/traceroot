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

describe("sendDigestAlertEmail", () => {
  beforeEach(() => {
    vi.resetModules();
    sendMail.mockReset();
    sendMail.mockResolvedValue(undefined);
    createTransport.mockClear();
    process.env.TRACEROOT_SMTP_URL = "smtp://user:pass@localhost:587";
    process.env.NEXT_PUBLIC_APP_URL = "https://app.example.com";
  });

  afterEach(() => {
    delete process.env.TRACEROOT_SMTP_URL;
    delete process.env.NEXT_PUBLIC_APP_URL;
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
});
