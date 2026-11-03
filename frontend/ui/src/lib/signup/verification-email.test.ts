import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  isVerificationMailConfigured,
  renderVerificationEmail,
  sendVerificationEmail,
  VERIFICATION_SUBJECT,
} from "./verification-email";

const user = { id: "u1", email: "kai@acme.io" };
const url = "https://app.traceroot.ai/api/auth/verify-email?token=abc&callbackURL=%2Fonboarding";
const asEnv = (vars: Record<string, string>) => vars as NodeJS.ProcessEnv;
const env = asEnv({ RESEND_API_KEY: "re_test", TRACEROOT_UPDATES_EMAIL_FROM: "hi@traceroot.ai" });

describe("isVerificationMailConfigured", () => {
  it("needs an API key and a sender, and nothing product-mail specific", () => {
    expect(isVerificationMailConfigured(env)).toBe(true);
    expect(isVerificationMailConfigured(asEnv({ ...env, RESEND_API_KEY: " " }))).toBe(false);
    expect(isVerificationMailConfigured(asEnv({ RESEND_API_KEY: "re_test" }))).toBe(false);
    expect(
      isVerificationMailConfigured(
        asEnv({ RESEND_API_KEY: "re_test", TRACEROOT_SMTP_MAIL_FROM: "a@b.io" }),
      ),
    ).toBe(true);
  });
});

describe("renderVerificationEmail", () => {
  it("puts the link in both bodies", () => {
    const { text, html } = renderVerificationEmail(url);
    expect(text).toContain(url);
    expect(html).toContain(`href="${url}"`);
  });
});

describe("sendVerificationEmail", () => {
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it("sends transactional mail, so no topic or unsubscribe is attached", async () => {
    const fetchImpl = vi.fn(async () => Response.json({ id: "email-1" }));
    await sendVerificationEmail({ user, url }, { env, fetchImpl });
    expect(fetchImpl).toHaveBeenCalledOnce();
    const body = JSON.parse(
      (fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].body as string,
    );
    expect(body).toMatchObject({ to: [user.email], subject: VERIFICATION_SUBJECT });
    expect(body.topic_id).toBeUndefined();
    expect(body.text).toContain(url);
  });

  it("never rejects when the provider fails", async () => {
    const fetchImpl = vi.fn(async () => new Response("boom", { status: 500 }));
    await expect(sendVerificationEmail({ user, url }, { env, fetchImpl })).resolves.toBeUndefined();
    expect(console.error).toHaveBeenCalled();
  });

  it("logs a skip when mail is unconfigured", async () => {
    const fetchImpl = vi.fn();
    await sendVerificationEmail({ user, url }, { env: asEnv({}), fetchImpl });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("no-api-key"));
  });
});
