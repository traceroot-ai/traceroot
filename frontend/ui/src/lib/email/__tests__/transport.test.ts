import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  createTransport: vi.fn(),
  sendMail: vi.fn(),
  env: {
    TRACEROOT_SMTP_URL: "smtp://user:pass@localhost:1025" as string | undefined,
    TRACEROOT_SMTP_MAIL_FROM: "noreply@example.com" as string | undefined,
  },
}));
vi.mock("nodemailer", () => ({
  default: { createTransport: m.createTransport },
}));
vi.mock("@/env", () => ({ env: m.env }));

import { isSmtpConfigured, sendSmtpEmail } from "../transport";

const message = {
  to: "member@example.com",
  subject: "Membership changed",
  html: "<p>Changed</p>",
  text: "Changed",
};

beforeEach(() => {
  vi.clearAllMocks();
  m.env.TRACEROOT_SMTP_URL = "smtp://user:pass@localhost:1025";
  m.env.TRACEROOT_SMTP_MAIL_FROM = "noreply@example.com";
  m.createTransport.mockReturnValue({ sendMail: m.sendMail });
  m.sendMail.mockResolvedValue(undefined);
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => vi.restoreAllMocks());

describe("SMTP email transport", () => {
  it("sends using the existing sender and bounds connection and idle waits", async () => {
    expect(await sendSmtpEmail(message)).toBe(true);
    expect(m.createTransport).toHaveBeenCalledWith({
      host: "localhost",
      port: 1025,
      secure: false,
      requireTLS: false,
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 10_000,
      auth: { user: "user", pass: "pass" },
    });
    expect(m.sendMail).toHaveBeenCalledWith({
      from: "traceroot <noreply@example.com>",
      ...message,
    });
  });

  it.each([undefined, "", " "])("skips unconfigured SMTP URL %j", async (value) => {
    m.env.TRACEROOT_SMTP_URL = value;
    expect(isSmtpConfigured()).toBe(false);
    expect(await sendSmtpEmail(message)).toBe(false);
    expect(m.createTransport).not.toHaveBeenCalled();
  });

  it("skips when there is no sender", async () => {
    m.env.TRACEROOT_SMTP_MAIL_FROM = undefined;
    expect(await sendSmtpEmail(message)).toBe(false);
    expect(m.sendMail).not.toHaveBeenCalled();
  });

  it("leaves delivery errors to the caller's post-commit policy", async () => {
    m.sendMail.mockRejectedValue(new Error("SMTP unavailable"));
    await expect(sendSmtpEmail(message)).rejects.toThrow("SMTP unavailable");
  });

  it("passes an IPv6 literal without URL brackets to the socket", async () => {
    m.env.TRACEROOT_SMTP_URL = "smtp://user:pass@[::1]:1025";
    await sendSmtpEmail(message);
    expect(m.createTransport).toHaveBeenCalledWith(
      expect.objectContaining({ host: "::1", port: 1025, secure: false, requireTLS: false }),
    );
  });
});
