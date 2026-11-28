import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  workspace: vi.fn(),
  user: vi.fn(),
  admins: vi.fn(),
  audit: vi.fn(),
  configured: vi.fn(),
  send: vi.fn(),
  after: vi.fn(),
}));

vi.mock("@traceroot/core", async (original) => ({
  ...(await original<typeof import("@traceroot/core")>()),
  prisma: {
    workspace: { findUnique: m.workspace },
    user: { findUnique: m.user },
    workspaceMember: { findMany: m.admins },
  },
}));
vi.mock("next/server", () => ({ after: m.after }));
vi.mock("@/env", () => ({ env: { BETTER_AUTH_URL: "https://app.example.com" } }));
vi.mock("@/lib/write-services/audit", () => ({ writeAudit: m.audit }));
vi.mock("@/lib/email/transport", () => ({
  isSmtpConfigured: m.configured,
  sendSmtpEmail: m.send,
}));

import { notifyMembershipChange, type MembershipChange } from "./membership-notifications";

const change: MembershipChange = {
  actorUserId: "actor1",
  workspaceId: "w1",
  membershipId: "m1",
  userId: "u1",
  role: "MEMBER",
  operation: "joined",
};

async function notifyAndDeliver(change: MembershipChange) {
  await notifyMembershipChange(change);
  for (const [callback] of m.after.mock.calls) await callback();
}

beforeEach(() => {
  vi.clearAllMocks();
  m.workspace.mockResolvedValue({ name: "Acme" });
  m.user.mockResolvedValue({ id: "u1", email: "Member@example.com" });
  m.admins.mockResolvedValue([
    { user: { id: "a1", email: "admin@example.com" } },
    { user: { id: "u1", email: "member@example.com" } },
  ]);
  m.audit.mockResolvedValue(undefined);
  m.configured.mockReturnValue(true);
  m.send.mockResolvedValue(true);
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => vi.restoreAllMocks());

describe("membership change notifications", () => {
  it("records the audit inline and leaves SMTP delivery until after the response", async () => {
    await notifyMembershipChange(change);
    expect(m.audit).toHaveBeenCalledOnce();
    expect(m.after).toHaveBeenCalledOnce();
    expect(m.send).not.toHaveBeenCalled();
    await m.after.mock.calls[0][0]();
    expect(m.send).toHaveBeenCalledTimes(2);
  });

  it("records the committed membership change on the existing audit trail", async () => {
    await notifyAndDeliver(change);
    expect(m.audit).toHaveBeenCalledExactlyOnceWith(expect.anything(), {
      actorUserId: "actor1",
      operation: "workspace_member_joined",
      resourceType: "workspace_member",
      resourceId: "m1",
      workspaceId: "w1",
      summary: { userId: "u1", role: "MEMBER" },
      transport: "ui",
    });
    expect(m.admins).toHaveBeenCalledWith({
      where: { workspaceId: "w1", role: "ADMIN" },
      select: { user: { select: { id: true, email: true } } },
    });
  });

  it("notifies the target and current admins once each without exposing recipient lists", async () => {
    await notifyAndDeliver(change);
    expect(m.send).toHaveBeenCalledTimes(2);
    const messages = m.send.mock.calls.map(([message]) => message);
    expect(messages.map((message) => message.to)).toEqual([
      "Member@example.com",
      "admin@example.com",
    ]);
    for (const message of messages) {
      expect(message.subject).toBe("Workspace membership changed on traceroot");
      expect(message.text).toBe(
        "Workspace: Acme\nAccount: Member@example.com\nChange: Joined as MEMBER",
      );
      expect(message.html).toContain('href="https://app.example.com/workspaces"');
      expect(message).not.toHaveProperty("cc");
      expect(message).not.toHaveProperty("bcc");
    }
  });

  it.each<
    [{ operation: MembershipChange["operation"]; previousRole?: MembershipChange["role"] }, string]
  >([
    [{ operation: "role_changed", previousRole: "ADMIN" }, "Role changed from ADMIN to MEMBER"],
    [{ operation: "role_changed" }, "Role changed to MEMBER"],
    [{ operation: "removed" }, "Removed from the workspace"],
  ])("describes and audits %j", async (fields, expected) => {
    await notifyAndDeliver({ ...change, ...fields });
    expect(m.send.mock.calls[0][0].text).toContain(expected);
    expect(m.audit.mock.calls[0][1]).toMatchObject({
      operation: `workspace_member_${fields.operation}`,
      summary: {
        userId: "u1",
        role: "MEMBER",
        ...(fields.previousRole ? { previousRole: fields.previousRole } : {}),
      },
    });
  });

  it("escapes workspace text in the HTML notification", async () => {
    m.workspace.mockResolvedValue({ name: "Acme <img src=x onerror=alert(1)> & partners" });
    await notifyAndDeliver(change);
    const html = m.send.mock.calls[0][0].html;
    expect(html).toContain("Acme &lt;img src=x onerror=alert(1)&gt; &amp; partners");
    expect(html).not.toContain("<img src=x");
  });

  it("preserves the audit even when SMTP is not configured", async () => {
    m.configured.mockReturnValue(false);
    await expect(notifyAndDeliver(change)).resolves.toBeUndefined();
    expect(m.audit).toHaveBeenCalledOnce();
    expect(m.workspace).not.toHaveBeenCalled();
    expect(m.send).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalledWith("[membership] SMTP not configured", {
      workspaceId: "w1",
      membershipId: "m1",
    });
  });

  it("isolates recipient failures and logs IDs for replay without failing the committed write", async () => {
    m.send.mockRejectedValueOnce(new Error("relay unavailable"));
    await expect(notifyAndDeliver(change)).resolves.toBeUndefined();
    expect(m.send).toHaveBeenCalledTimes(2);
    expect(console.error).toHaveBeenCalledWith("[membership] notification failed", {
      workspaceId: "w1",
      membershipId: "m1",
      recipientUserId: "u1",
      error: "relay unavailable",
    });
  });

  it("does not fail the committed write when recipient lookup fails", async () => {
    m.admins.mockRejectedValue(new Error("database unavailable"));
    await expect(notifyAndDeliver(change)).resolves.toBeUndefined();
    expect(m.audit).toHaveBeenCalledOnce();
    expect(m.send).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith("[membership] notification lookup failed", {
      workspaceId: "w1",
      membershipId: "m1",
      userId: "u1",
      error: "database unavailable",
    });
  });

  it.each(["workspace", "user"] as const)(
    "logs when the %s disappeared after commit",
    async (record) => {
      m[record].mockResolvedValue(null);
      await expect(notifyAndDeliver(change)).resolves.toBeUndefined();
      expect(m.send).not.toHaveBeenCalled();
      expect(console.error).toHaveBeenCalled();
    },
  );

  it("still notifies a removed account when it is no longer among the admins", async () => {
    m.admins.mockResolvedValue([]);
    await notifyAndDeliver({ ...change, operation: "removed" });
    expect(m.send).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        to: "Member@example.com",
        text: "Workspace: Acme\nAccount: Member@example.com\nChange: Removed from the workspace",
      }),
    );
  });
});
