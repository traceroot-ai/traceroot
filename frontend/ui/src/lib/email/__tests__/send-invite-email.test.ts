import { beforeEach, describe, expect, it, vi } from "vitest";

const sendMail = vi.fn();
const createTransport = vi.fn(() => ({ sendMail }));
const smtpEnv = vi.hoisted(() => ({
  TRACEROOT_SMTP_URL: "smtps://user:pass@mail.example.com",
  TRACEROOT_SMTP_MAIL_FROM: "noreply@traceroot.ai",
  BETTER_AUTH_URL: "https://app.example.com",
}));

vi.mock("nodemailer", () => ({
  default: { createTransport },
}));

vi.mock("@/env", () => ({
  env: smtpEnv,
}));

const baseParams = {
  to: "new.member@example.com",
  inviterName: "Kai",
  inviterEmail: "kai@example.com",
  workspaceName: "Acme",
  inviteId: "inv123",
  role: "MEMBER",
};

describe("sendInviteEmail", () => {
  beforeEach(() => {
    vi.resetModules();
    createTransport.mockClear();
    sendMail.mockReset();
    sendMail.mockResolvedValue(undefined);
    smtpEnv.TRACEROOT_SMTP_URL = "smtps://user:pass@mail.example.com";
  });

  it("sends the branded invite with inviter, workspace, role, and accept link", async () => {
    const { sendInviteEmail } = await import("../send-invite-email");
    await sendInviteEmail(baseParams);

    expect(sendMail).toHaveBeenCalledTimes(1);
    const mail = sendMail.mock.calls[0][0];

    expect(mail.to).toBe("new.member@example.com");
    expect(mail.subject).toBe('Kai invited you to join "Acme" on TraceRoot');

    expect(mail.html).toContain("Join Acme on TraceRoot");
    expect(mail.html).toContain("kai@example.com");
    // role is title-cased for display
    expect(mail.html).toContain("<strong>Member</strong>");
    expect(mail.html).toContain('href="https://app.example.com/invites/inv123"');
    expect(mail.html).toContain("Accept Invitation");

    // plain-text twin carries the same essentials
    expect(mail.text).toContain("https://app.example.com/invites/inv123");
    expect(mail.text).toContain("Acme");
  });

  it("uses implicit TLS defaults for a portless smtps URL", async () => {
    const { sendInviteEmail } = await import("../send-invite-email");
    await sendInviteEmail(baseParams);

    expect(createTransport).toHaveBeenCalledWith(
      expect.objectContaining({
        host: "mail.example.com",
        port: 465,
        secure: true,
      }),
    );
  });

  it("uses the STARTTLS port for a portless smtp URL", async () => {
    smtpEnv.TRACEROOT_SMTP_URL = "smtp://user:pass@mail.example.com";
    const { sendInviteEmail } = await import("../send-invite-email");
    await sendInviteEmail(baseParams);

    expect(createTransport).toHaveBeenCalledWith(
      expect.objectContaining({
        host: "mail.example.com",
        port: 587,
        secure: false,
      }),
    );
  });

  it("keeps implicit TLS for an explicit port 465", async () => {
    smtpEnv.TRACEROOT_SMTP_URL = "smtp://user:pass@mail.example.com:465";
    const { sendInviteEmail } = await import("../send-invite-email");
    await sendInviteEmail(baseParams);

    expect(createTransport).toHaveBeenCalledWith(
      expect.objectContaining({
        port: 465,
        secure: true,
      }),
    );
  });

  it("keeps implicit TLS on a custom smtps port", async () => {
    smtpEnv.TRACEROOT_SMTP_URL = "smtps://user:pass@mail.example.com:2465";
    const { sendInviteEmail } = await import("../send-invite-email");
    await sendInviteEmail(baseParams);

    expect(createTransport).toHaveBeenCalledWith(
      expect.objectContaining({
        port: 2465,
        secure: true,
      }),
    );
  });

  it("escapes HTML in user-provided fields", async () => {
    const { sendInviteEmail } = await import("../send-invite-email");
    await sendInviteEmail({
      ...baseParams,
      inviterName: `<img src=x onerror=alert(1)>`,
      workspaceName: `Acme <b>&</b>`,
    });

    const mail = sendMail.mock.calls[0][0];
    expect(mail.html).not.toContain("<img src=x");
    expect(mail.html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(mail.html).toContain("Acme &lt;b&gt;&amp;&lt;/b&gt;");
  });
});
