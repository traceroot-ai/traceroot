import { describe, expect, it, vi } from "vitest";
import { ensureContact, sendEmail, setTopicSubscription } from "../lib/email/resend.ts";

const env = {
  RESEND_API_KEY: "re_test_key_000",
  RESEND_PRODUCT_TOPIC_ID: "topic-123",
  TRACEROOT_EMAIL_FROM: "lucas@traceroot.ai",
} as NodeJS.ProcessEnv;
const email = { to: "a@x.io", subject: "Hi", text: "hello", kind: "product" as const };

function mockResend(status: number, body: unknown, overrides: NodeJS.ProcessEnv = {}) {
  const fetchImpl = vi.fn(async () => new Response(JSON.stringify(body), { status }));
  const sent = () => {
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    return { url, init, headers, body: JSON.parse(init.body as string) as Record<string, unknown> };
  };
  return { fetchImpl: fetchImpl as unknown as typeof fetch, env: { ...env, ...overrides }, sent };
}

vi.spyOn(console, "warn").mockImplementation(() => {});

describe("sendEmail", () => {
  it.each([
    ["no-api-key", { RESEND_API_KEY: "" }],
    ["product-requires-topic", { RESEND_PRODUCT_TOPIC_ID: undefined }],
  ])("skips with %s and calls nothing", async (reason, override) => {
    const api = mockResend(200, { id: "x" }, override);
    expect(await sendEmail(email, api)).toEqual({ sent: false, reason });
    expect(api.fetchImpl).not.toHaveBeenCalled();
  });

  it("sends product mail with topic, idempotency key, headers, sanitized tags and footer", async () => {
    const api = mockResend(200, { id: "email-1" });
    const headers = { "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" };
    const html = "<body><p>hello</p></body>";
    const product = { ...email, html, idempotencyKey: "w/u1", tags: { t: "a b" }, headers };
    expect(await sendEmail(product, api)).toEqual({ sent: true, id: "email-1" });
    const { url, headers: h, body } = api.sent();
    expect([url, h.Authorization, h["Idempotency-Key"]]).toEqual([
      "https://api.resend.com/emails",
      "Bearer re_test_key_000",
      "w/u1",
    ]);
    expect(body).toEqual({
      from: "lucas@traceroot.ai",
      reply_to: "lucas@traceroot.ai",
      to: ["a@x.io"],
      subject: "Hi",
      text: "hello\n\nTraceRoot, Inc. · 989 Market St, San Francisco, CA 94103",
      html: '<body><p>hello</p><p style="font-size:12px;color:#777">TraceRoot, Inc. · 989 Market St, San Francisco, CA 94103</p></body>',
      topic_id: "topic-123",
      headers,
      tags: [{ name: "t", value: "a_b" }],
    });
  });

  it.each([
    ["Lucas <lucas@traceroot.ai>", undefined, "lucas@traceroot.ai"],
    ["lucas@traceroot.ai", "hi@traceroot.ai", "hi@traceroot.ai"],
  ])(
    "sends from %s as-is and replies to TRACEROOT_EMAIL_REPLY_TO or the bare address",
    async (from, replyTo, expected) => {
      const api = mockResend(
        200,
        { id: "x" },
        { TRACEROOT_EMAIL_FROM: from, TRACEROOT_EMAIL_REPLY_TO: replyTo },
      );
      await sendEmail(email, api);
      expect(api.sent().body).toMatchObject({ from, reply_to: expected });
    },
  );

  it("sends transactional mail with no topic and the text unchanged", async () => {
    const api = mockResend(200, { id: "email-2" });
    await sendEmail({ ...email, kind: "transactional" }, api);
    const { body } = api.sent();
    expect(body.text).toBe("hello");
    expect(body).not.toHaveProperty("topic_id");
  });

  it("throws on a non-2xx with the status and never the key", async () => {
    const api = mockResend(422, { message: "Invalid `from` field" });
    const error = String(await sendEmail(email, api).catch((e: Error) => e));
    expect(error).toMatch(/^Error: Resend send failed \(422\)/);
    expect(error).not.toContain("re_test_key_000");
  });
});

describe("ensureContact", () => {
  const replies = (...statuses: number[]) =>
    statuses.reduce(
      (fn, status) => fn.mockResolvedValueOnce(new Response("{}", { status })),
      vi.fn(),
    ) as unknown as typeof fetch;
  const call = (fetchImpl: typeof fetch, n: number) => {
    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[n] as [
      string,
      RequestInit,
    ];
    return {
      url,
      method: init.method,
      body: init.body ? JSON.parse(init.body as string) : undefined,
    };
  };

  it("looks the contact up and leaves an existing one untouched", async () => {
    const fetchImpl = replies(200);
    expect(await ensureContact({ email: " Ada@X.io ", name: "Ada" }, { fetchImpl, env })).toEqual({
      ok: true,
    });
    expect(call(fetchImpl, 0)).toEqual({
      url: "https://api.resend.com/contacts/ada%40x.io",
      method: "GET",
      body: undefined,
    });
    expect((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
  });

  it("creates a missing contact with the split name", async () => {
    const fetchImpl = replies(404, 201);
    expect(
      await ensureContact({ email: "Ada@X.io", name: "Ada Lovelace" }, { fetchImpl, env }),
    ).toEqual({ ok: true });
    expect(call(fetchImpl, 1)).toEqual({
      url: "https://api.resend.com/contacts",
      method: "POST",
      body: { email: "ada@x.io", first_name: "Ada", last_name: "Lovelace" },
    });
  });

  it.each([
    ["lookup fails", [500]],
    ["create fails", [404, 422]],
  ])("is ok:false when the %s", async (_label, statuses) => {
    expect(
      await ensureContact({ email: "a@x.io" }, { fetchImpl: replies(...statuses), env }),
    ).toEqual({ ok: false });
  });
});

describe("setTopicSubscription", () => {
  it("PATCHes a root-level array to the contact's topics, or ok:false without a topic", async () => {
    const api = mockResend(200, { data: [] });
    expect(await setTopicSubscription(" A+B@X.io", "opt_out", api)).toEqual({ ok: true });
    const { url, init, body } = api.sent();
    expect(url).toBe("https://api.resend.com/contacts/a%2Bb%40x.io/topics");
    expect(init.method).toBe("PATCH");
    expect(body).toEqual([{ id: "topic-123", subscription: "opt_out" }]);
    const noTopic = mockResend(200, {}, { RESEND_PRODUCT_TOPIC_ID: undefined });
    expect(await setTopicSubscription("a@x.io", "opt_in", noTopic)).toEqual({ ok: false });
    expect(noTopic.fetchImpl).not.toHaveBeenCalled();
  });
});
