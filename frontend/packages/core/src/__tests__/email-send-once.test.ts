import { Prisma } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { sendOnce } from "../lib/email/send-once.ts";
import type { EmailSendClient } from "../lib/email/send-record.ts";

const [create, findUnique, updateMany, deleteMany] = [vi.fn(), vi.fn(), vi.fn(), vi.fn()];
const db = {
  emailSend: { create, findUnique, updateMany, deleteMany },
} as unknown as EmailSendClient;
const key = { userId: "u1", campaign: "welcome", kind: "product" as const };
const env = {
  RESEND_API_KEY: "re_test_key_000",
  RESEND_PRODUCT_TOPIC_ID: "topic-123",
  TRACEROOT_EMAIL_FROM: "a@x.io",
} as NodeJS.ProcessEnv;
const email = { to: "a@x.io", subject: "Hi", text: "hi", kind: "product" as const };
const build = () => ({ ...email, idempotencyKey: "k1" });
const broken = () => {
  throw new Error("no template");
};
const dup = new Prisma.PrismaClientKnownRequestError("x", { code: "P2002", clientVersion: "5" });
const fetchImpl = vi.fn<typeof fetch>();
const options = { fetchImpl, env };
const respond = (status: number, body: unknown) =>
  fetchImpl.mockImplementation(async () => new Response(JSON.stringify(body), { status }));

vi.spyOn(console, "log").mockImplementation(() => {});
vi.spyOn(console, "error").mockImplementation(() => {});

beforeEach(() => {
  vi.clearAllMocks();
  create.mockResolvedValue({ id: "send-1" });
  updateMany.mockResolvedValue({ count: 1 });
  deleteMany.mockResolvedValue({ count: 1 });
});

describe("sendOnce", () => {
  it("claims, sends with the idempotency key, then stamps the provider id", async () => {
    respond(200, { id: "email-1" });
    expect(await sendOnce(db, key, build, options)).toEqual({ status: "sent", id: "email-1" });
    expect(create.mock.lastCall).toMatchObject([{ data: key }]);
    expect(fetchImpl.mock.lastCall?.[1]).toMatchObject({ headers: { "Idempotency-Key": "k1" } });
    expect(updateMany.mock.lastCall).toMatchObject([{ data: { providerId: "email-1" } }]);
    expect(deleteMany).not.toHaveBeenCalled();
  });

  it.each([
    ["already-sent", new Date("2026-10-01T00:00:00Z")],
    ["in-flight", null],
  ])("returns %s after losing the claim, without building or sending", async (status, sentAt) => {
    create.mockRejectedValue(dup);
    findUnique.mockResolvedValue({ id: "send-1", sentAt });
    const buildSpy = vi.fn(build);
    expect(await sendOnce(db, key, buildSpy, options)).toEqual({ status });
    expect(buildSpy).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("releases the claim when the send is skipped", async () => {
    const result = await sendOnce(db, key, build, {
      fetchImpl,
      env: { ...env, RESEND_API_KEY: "" },
    });
    expect(result).toEqual({ status: "skipped", reason: "no-api-key" });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(deleteMany).toHaveBeenCalledTimes(1);
    expect(updateMany).not.toHaveBeenCalled();
  });

  it.each([
    ["send", build, 500, /500/],
    ["build", broken, 200, /no template/],
  ])("returns failed and releases the claim when the %s throws", async (_, impl, status, re) => {
    respond(status, { id: "x", message: "boom" });
    const result = await sendOnce(db, key, impl, options);
    expect(result).toEqual({ status: "failed", error: expect.stringMatching(re) });
    expect(deleteMany).toHaveBeenCalledTimes(1);
    expect(updateMany).not.toHaveBeenCalled();
  });

  it("still reports sent when the stamp is lost, never releasing", async () => {
    updateMany.mockResolvedValue({ count: 0 });
    respond(200, { id: "email-1" });
    expect(await sendOnce(db, key, build, options)).toEqual({ status: "sent", id: "email-1" });
    expect(deleteMany).not.toHaveBeenCalled();
  });
});
