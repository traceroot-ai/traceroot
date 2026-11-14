import { beforeEach, describe, expect, it, vi } from "vitest";

const sendMail = vi.fn();
const createTransport = vi.hoisted(() => vi.fn());
const env = vi.hoisted(() => ({
  TRACEROOT_SMTP_URL: "smtp://user:pass@localhost:587" as string | undefined,
  TRACEROOT_SMTP_MAIL_FROM: "noreply@traceroot.ai" as string | undefined,
}));

vi.mock("nodemailer", () => ({
  default: {
    createTransport: (options: unknown) => {
      createTransport(options);
      return { sendMail };
    },
  },
}));
vi.mock("@/env", () => ({ env }));

import { isSmtpConfigured, sendPasswordResetEmail } from "../send-password-reset-email";

const RESET_URL =
  "https://app.example.com/api/auth/reset-password/tok?callbackURL=%2Fauth%2Freset-password";

describe("sendPasswordResetEmail", () => {
  beforeEach(() => {
    sendMail.mockReset();
    sendMail.mockResolvedValue(undefined);
    env.TRACEROOT_SMTP_URL = "smtp://user:pass@localhost:587";
    env.TRACEROOT_SMTP_MAIL_FROM = "noreply@traceroot.ai";
  });

  it("sends the reset link in both the html and text parts", async () => {
    await sendPasswordResetEmail({ to: "a@example.com", resetUrl: RESET_URL });
    expect(sendMail).toHaveBeenCalledTimes(1);
    const mail = sendMail.mock.calls[0][0];
    expect(mail.to).toBe("a@example.com");
    expect(mail.from).toBe("TraceRoot <noreply@traceroot.ai>");
    expect(mail.subject).toBe("Reset your TraceRoot password");
    expect(mail.html).toContain(`href="${RESET_URL}"`);
    expect(mail.text).toContain(RESET_URL);
  });

  it("skips sending when SMTP is not configured", async () => {
    env.TRACEROOT_SMTP_URL = undefined;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await sendPasswordResetEmail({ to: "a@example.com", resetUrl: RESET_URL });
    expect(sendMail).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe("sendPasswordResetEmail SMTP connection", () => {
  beforeEach(() => {
    createTransport.mockReset();
    sendMail.mockResolvedValue(undefined);
    env.TRACEROOT_SMTP_MAIL_FROM = "noreply@traceroot.ai";
  });

  it("uses implicit TLS on port 465 and decodes the credentials", async () => {
    env.TRACEROOT_SMTP_URL = "smtp://us%40er:p%40ss@mail.example.com:465";
    await sendPasswordResetEmail({ to: "a@example.com", resetUrl: RESET_URL });
    expect(createTransport).toHaveBeenCalledWith({
      host: "mail.example.com",
      port: 465,
      secure: true,
      requireTLS: false,
      auth: { user: "us@er", pass: "p@ss" },
    });
  });

  it("uses implicit TLS on port 465 for an smtps:// URL without a port", async () => {
    env.TRACEROOT_SMTP_URL = "smtps://user:pass@mail.example.com";
    await sendPasswordResetEmail({ to: "a@example.com", resetUrl: RESET_URL });
    expect(createTransport).toHaveBeenCalledWith(
      expect.objectContaining({ port: 465, secure: true }),
    );
  });

  // Without TLS an on-path attacker could strip STARTTLS and read the reset link.
  it("requires STARTTLS on port 587 when the URL has no port", async () => {
    env.TRACEROOT_SMTP_URL = "smtp://user:pass@mail.example.com";
    await sendPasswordResetEmail({ to: "a@example.com", resetUrl: RESET_URL });
    expect(createTransport).toHaveBeenCalledWith(
      expect.objectContaining({ port: 587, secure: false, requireTLS: true }),
    );
  });

  it("does not ask for STARTTLS on top of implicit TLS", async () => {
    env.TRACEROOT_SMTP_URL = "smtps://user:pass@mail.example.com";
    await sendPasswordResetEmail({ to: "a@example.com", resetUrl: RESET_URL });
    expect(createTransport).toHaveBeenCalledWith(expect.objectContaining({ requireTLS: false }));
  });

  it("allows a plaintext relay on the same host", async () => {
    env.TRACEROOT_SMTP_URL = "smtp://user:pass@localhost:1025";
    await sendPasswordResetEmail({ to: "a@example.com", resetUrl: RESET_URL });
    expect(createTransport).toHaveBeenCalledWith(
      expect.objectContaining({ port: 1025, secure: false, requireTLS: false }),
    );
  });
});

describe("isSmtpConfigured", () => {
  it("is true only when both the URL and the sender are set", () => {
    env.TRACEROOT_SMTP_URL = "smtp://user:pass@localhost:587";
    env.TRACEROOT_SMTP_MAIL_FROM = "noreply@traceroot.ai";
    expect(isSmtpConfigured()).toBe(true);
    env.TRACEROOT_SMTP_MAIL_FROM = " ";
    expect(isSmtpConfigured()).toBe(false);
  });
});
