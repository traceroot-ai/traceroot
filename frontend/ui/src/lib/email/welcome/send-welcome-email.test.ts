import { beforeEach, expect, it, vi } from "vitest";

vi.mock("@/env", () => ({
  env: { NEXT_PUBLIC_APP_URL: "https://app.example.com" },
}));
const core = vi.hoisted(() => ({
  sendOnce: vi.fn(),
  resendConfig: vi.fn(),
  signUnsubscribeToken: vi.fn(),
  unsubscribeHeaders: vi.fn(),
  UNSUBSCRIBE_PATH: "/api/email/unsubscribe",
}));
vi.mock("@traceroot/core/email", () => core);
const prisma = vi.hoisted(() => ({ emailSend: {} }));
vi.mock("@traceroot/core", () => ({ prisma, escapeHtml: (s: string) => s }));

import { sendWelcomeEmail } from "./send-welcome-email";

const input = { userId: "u1", email: "New@Example.com", name: "new user" };
const replyTo = "hello@example.com";
const unsubscribeUrl = "https://app.example.com/api/email/unsubscribe?t=tok.sig";
beforeEach(() => {
  vi.resetAllMocks();
  core.sendOnce.mockResolvedValue({ status: "sent", id: "email1" });
  core.resendConfig.mockReturnValue({ from: "me@example.com", replyTo });
  core.signUnsubscribeToken.mockReturnValue("tok.sig");
  core.unsubscribeHeaders.mockReturnValue({ "List-Unsubscribe": "<x>" });
});

it("asks sendOnce for one welcome product send per user and returns its result", async () => {
  expect(await sendWelcomeEmail(input)).toEqual({ status: "sent", id: "email1" });
  const [db, key, build] = core.sendOnce.mock.calls[0];
  expect(db).toBe(prisma);
  expect(key).toEqual({ userId: "u1", campaign: "welcome", kind: "product" });
  const email = build();
  expect(email).toMatchObject({
    to: "New@Example.com",
    subject: "Making the most of TraceRoot",
    kind: "product",
    replyTo,
    idempotencyKey: "welcome/u1",
    headers: { "List-Unsubscribe": "<x>" },
  });
  expect(core.signUnsubscribeToken).toHaveBeenCalledWith("New@Example.com");
  expect(core.unsubscribeHeaders).toHaveBeenCalledWith({ url: unsubscribeUrl, mailto: replyTo });
  expect(email.text).toContain("Hi new,");
  expect(email.text).toContain("Best,\nThe TraceRoot Devs\n");
  expect(email.text).toContain(unsubscribeUrl);
  const other = { emailSend: {} } as never;
  const fetchImpl = vi.fn() as never;
  await sendWelcomeEmail(input, { db: other, fetchImpl });
  expect(core.sendOnce).toHaveBeenLastCalledWith(other, key, expect.any(Function), { fetchImpl });
});
