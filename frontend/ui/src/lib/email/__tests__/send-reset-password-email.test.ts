import { beforeEach, describe, expect, it, vi } from "vitest";

const sendMail = vi.fn();
const sendResendEmail = vi.fn();
const resendConfig = vi.fn();

vi.mock("nodemailer", () => ({
  default: { createTransport: () => ({ sendMail }) },
}));

vi.mock("@traceroot/core/email", () => ({
  resendConfig: () => resendConfig(),
  sendEmail: (...args: unknown[]) => sendResendEmail(...args),
}));

vi.mock("@/env", () => ({
  env: {
    TRACEROOT_SMTP_URL: "smtp://user:pass@localhost:587",
    TRACEROOT_SMTP_MAIL_FROM: "noreply@traceroot.ai",
    BETTER_AUTH_URL: "https://app.example.com",
  },
}));

const baseParams = {
  to: "user@example.com",
  name: "Gaurav",
  resetUrl: "https://app.example.com/reset-password/token123",
};

describe("sendResetPasswordEmail", () => {
  beforeEach(() => {
    vi.resetModules();
    sendMail.mockReset();
    sendResendEmail.mockReset();
    resendConfig.mockReset();
  });

  it("sends via Resend when Resend API key and sender are configured", async () => {
    resendConfig.mockReturnValue({
      apiKey: "re_12345",
      from: "updates@traceroot.ai",
    });
    sendResendEmail.mockResolvedValue({ sent: true, id: "email_123" });

    const { sendResetPasswordEmail } = await import("../send-reset-password-email");
    await sendResetPasswordEmail(baseParams);

    expect(sendResendEmail).toHaveBeenCalledTimes(1);
    const sent = sendResendEmail.mock.calls[0][0];
    expect(sent.to).toBe("user@example.com");
    expect(sent.kind).toBe("transactional");
    expect(sent.subject).toBe("Reset your TraceRoot password");
    expect(sent.html).toContain("https://app.example.com/reset-password/token123");
    expect(sendMail).not.toHaveBeenCalled();
  });

  it("falls back to SMTP when Resend is not configured", async () => {
    resendConfig.mockReturnValue({ apiKey: undefined, from: undefined });
    sendMail.mockResolvedValue(undefined);

    const { sendResetPasswordEmail } = await import("../send-reset-password-email");
    await sendResetPasswordEmail(baseParams);

    expect(sendResendEmail).not.toHaveBeenCalled();
    expect(sendMail).toHaveBeenCalledTimes(1);
    const mail = sendMail.mock.calls[0][0];
    expect(mail.to).toBe("user@example.com");
    expect(mail.subject).toBe("Reset your TraceRoot password");
    expect(mail.html).toContain("Reset your TraceRoot password");
    expect(mail.html).toContain("Gaurav");
    expect(mail.html).toContain('href="https://app.example.com/reset-password/token123"');
    expect(mail.text).toContain("https://app.example.com/reset-password/token123");
  });

  it("escapes user-provided name in the HTML email", async () => {
    resendConfig.mockReturnValue({ apiKey: undefined, from: undefined });
    sendMail.mockResolvedValue(undefined);

    const { sendResetPasswordEmail } = await import("../send-reset-password-email");
    await sendResetPasswordEmail({
      ...baseParams,
      name: `<script>alert("xss")</script>`,
    });

    const mail = sendMail.mock.calls[0][0];
    expect(mail.html).not.toContain("<script>");
    expect(mail.html).toContain("&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;");
  });

  it("logs to console and does not throw when neither Resend nor SMTP is configured", async () => {
    resendConfig.mockReturnValue({ apiKey: undefined, from: undefined });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    // Temporarily override env module
    vi.doMock("@/env", () => ({
      env: {
        TRACEROOT_SMTP_URL: undefined,
        TRACEROOT_SMTP_MAIL_FROM: undefined,
      },
    }));

    const { sendResetPasswordEmail } = await import("../send-reset-password-email");
    await expect(sendResetPasswordEmail(baseParams)).resolves.not.toThrow();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("Password reset link for user@example.com"),
    );
    warnSpy.mockRestore();
  });
});
