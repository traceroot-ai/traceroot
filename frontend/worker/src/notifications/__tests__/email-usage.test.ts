import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sendMail = vi.fn();

vi.mock("nodemailer", () => ({
  default: { createTransport: () => ({ sendMail }) },
}));

const baseParams = {
  to: ["admin@example.com", "owner@example.com"],
  kind: "warning" as const,
  meter: "events" as const,
  workspaceId: "ws-1",
  workspaceName: "Acme <script>",
  used: 40_000,
  cap: 50_000,
};

describe("sendUsageQuotaEmail", () => {
  beforeEach(() => {
    vi.resetModules();
    sendMail.mockReset();
    sendMail.mockResolvedValue(undefined);
    process.env.TRACEROOT_SMTP_URL = "smtp://user:pass@localhost:587";
    process.env.NEXT_PUBLIC_APP_URL = "https://app.example.com";
  });

  afterEach(() => {
    delete process.env.TRACEROOT_SMTP_URL;
    delete process.env.NEXT_PUBLIC_APP_URL;
  });

  it("sends a warning email with usage, escaped workspace name, and billing link", async () => {
    const { sendUsageQuotaEmail } = await import("../email.js");
    const ok = await sendUsageQuotaEmail(baseParams);

    expect(ok).toBe(true);
    expect(sendMail).toHaveBeenCalledTimes(1);
    const mail = sendMail.mock.calls[0][0];

    expect(mail.to).toBe("admin@example.com, owner@example.com");
    expect(mail.subject).toContain("approaching");
    expect(mail.subject).toContain("events");
    // user-supplied workspace name is escaped in HTML
    expect(mail.html).toContain("Acme &lt;script&gt;");
    expect(mail.html).not.toContain("<script>");
    expect(mail.html).toContain("40,000");
    expect(mail.html).toContain("50,000");
    expect(mail.html).toContain("https://app.example.com/workspaces/ws-1/settings/billing");
    // plain-text twin carries the same essentials
    expect(mail.text).toContain("40,000 of 50,000");
    expect(mail.text).toContain("https://app.example.com/workspaces/ws-1/settings/billing");
  });

  it("blocked email names the paused feature per meter", async () => {
    const { sendUsageQuotaEmail } = await import("../email.js");
    await sendUsageQuotaEmail({
      ...baseParams,
      kind: "blocked",
      meter: "detector",
      used: 100,
      cap: 100,
    });

    const mail = sendMail.mock.calls[0][0];
    expect(mail.subject).toContain("limit reached");
    expect(mail.html).toContain("Detector scans are paused");
    expect(mail.text).toContain("Detector scans are paused");
  });

  it("returns false without sending when the recipient list is empty", async () => {
    const { sendUsageQuotaEmail } = await import("../email.js");
    expect(await sendUsageQuotaEmail({ ...baseParams, to: [] })).toBe(false);
    expect(sendMail).not.toHaveBeenCalled();
  });

  it("returns false when SMTP is not configured", async () => {
    delete process.env.TRACEROOT_SMTP_URL;
    const { sendUsageQuotaEmail } = await import("../email.js");
    expect(await sendUsageQuotaEmail(baseParams)).toBe(false);
    expect(sendMail).not.toHaveBeenCalled();
  });

  it("returns false when the transport errors, without throwing", async () => {
    sendMail.mockRejectedValue(new Error("smtp down"));
    const { sendUsageQuotaEmail } = await import("../email.js");
    expect(await sendUsageQuotaEmail(baseParams)).toBe(false);
  });
});
