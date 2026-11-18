import { describe, expect, it } from "vitest";
import { REDACTED, isCredentialKey, redactCredentials } from "../redaction.js";

const redact = (value: unknown) => {
  const tally = { redactions: 0 };
  return { value: redactCredentials(value, tally) as Record<string, unknown>, ...tally };
};

describe("isCredentialKey", () => {
  it.each([
    "authorization",
    "Authorization",
    "proxy-authorization",
    "api_key",
    "apiKey",
    "apikey",
    "x-api-key",
    "OPENAI_API_KEY",
    "openai.api_key",
    "password",
    "db_password",
    "client_secret",
    "secret",
    "token",
    "auth_token",
    "access_token",
    "refreshToken",
    "id_token",
    "cookie",
    "set-cookie",
    "private_key",
    "privateKey",
    "http.request.header.authorization",
    "credentials",
  ])("%s is a credential", (key) => {
    expect(isCredentialKey(key)).toBe(true);
  });

  it.each([
    "prompt_tokens",
    "completion_tokens",
    "total_tokens",
    "max_tokens",
    "llm.usage.prompt_tokens",
    "gen_ai.usage.input_tokens",
    "llm.token_count.prompt",
    "token_count",
    "token_type",
    "next_token",
    "page_token",
    "continuation_token",
    "key",
    "trace_id",
    "secret_name",
    "keyword",
    "monkey",
    "author",
  ])("%s is not a credential", (key) => {
    expect(isCredentialKey(key)).toBe(false);
  });
});

describe("redactCredentials", () => {
  it("redacts credential keys at any depth and lists them next to the value", () => {
    const { value, redactions } = redact({
      trace_id: "t1",
      spans: [
        {
          span_id: "s1",
          attributes: {
            "http.request.header.authorization": "Bearer abc.def.ghi",
            api_key: "k-123",
            model: "m",
          },
        },
      ],
    });
    const attributes = (value.spans as { attributes: Record<string, unknown> }[])[0]!.attributes;
    expect(attributes).toEqual({
      "http.request.header.authorization": REDACTED,
      api_key: REDACTED,
      model: "m",
      _redactedKeys: ["http.request.header.authorization", "api_key"],
    });
    expect(value.trace_id).toBe("t1");
    expect(redactions).toBe(2);
  });

  it("keeps token counts and other numbers and flags under any key", () => {
    const usage = {
      "llm.usage.prompt_tokens": 410,
      "llm.usage.completion_tokens": 120,
      total_tokens: 530,
      token: 5,
      has_password: true,
    };
    const { value, redactions } = redact({ usage });
    expect(value.usage).toEqual(usage);
    expect(redactions).toBe(0);
  });

  it("redacts a whole object or list under a credential key", () => {
    const { value } = redact({ credentials: { user: "u", pass: "p" }, cookies: ["a=1"] });
    expect(value).toEqual({
      credentials: REDACTED,
      cookies: REDACTED,
      _redactedKeys: ["credentials", "cookies"],
    });
  });

  it("judges an attribute-list entry by its key", () => {
    const { value } = redact({
      attributes: [
        { key: "x-api-key", value: { stringValue: "abc" } },
        { key: "model", value: { stringValue: "m" } },
      ],
    });
    expect(value.attributes).toEqual([
      { key: "x-api-key", value: REDACTED, _redactedKeys: ["x-api-key"] },
      { key: "model", value: { stringValue: "m" } },
    ]);
  });

  it("redacts secret query parameters and passwords in URLs, keeping the rest", () => {
    const { value } = redact({
      base_url: "https://api.provider.test/v1/chat?api-version=2024&api_key=sk123&key=abc",
      next_url: "https://traceroot.test/traces?cursor=c2&limit=50",
      dsn: "postgres://app:hunter2@db.internal:5432/main",
      note: "called https://x.test/hook?token=t0k3n then retried",
    });
    expect(value.base_url).toBe(
      `https://api.provider.test/v1/chat?api-version=2024&api_key=${REDACTED}&key=${REDACTED}`,
    );
    expect(value.next_url).toBe("https://traceroot.test/traces?cursor=c2&limit=50");
    expect(value.dsn).toBe(`postgres://app:${REDACTED}@db.internal:5432/main`);
    expect(value.note).toBe(`called https://x.test/hook?token=${REDACTED} then retried`);
    expect(value._redactedKeys).toEqual(["base_url", "dsn", "note"]);
  });

  it("replaces values that are credentials on their own, wherever they sit", () => {
    const pem = "-----BEGIN RSA PRIVATE KEY-----\nMIIEow\n-----END RSA PRIVATE KEY-----";
    const { value, redactions } = redact({
      input: "use Authorization: Bearer eyJhbGciOi.payload12.sig and sk-proj-abcdefghijklmnop1234",
      output: `key file:\n${pem}\ndone`,
      aws: "AKIAABCDEFGHIJKLMNOP",
      plain: "nothing to see; Bearer instruments; sk-short",
    });
    expect(value.input).toBe(`use Authorization: Bearer ${REDACTED} and ${REDACTED}`);
    expect(value.output).toBe(`key file:\n${REDACTED}\ndone`);
    expect(value.aws).toBe(REDACTED);
    expect(value.plain).toBe("nothing to see; Bearer instruments; sk-short");
    expect(redactions).toBe(4);
  });

  it("redacts inside a string that holds JSON, and re-encodes it", () => {
    const { value } = redact({
      "llm.invocation_parameters": JSON.stringify({ model: "m", password: "p", max_tokens: 10 }),
    });
    expect(JSON.parse(value["llm.invocation_parameters"] as string)).toEqual({
      model: "m",
      password: REDACTED,
      max_tokens: 10,
      _redactedKeys: ["password"],
    });
    expect(value._redactedKeys).toEqual(["llm.invocation_parameters"]);
  });

  it("returns the same value when there is nothing to redact", () => {
    const input = { a: [1, "two", { b: null }], embedded: '{"x":1}' };
    const { value, redactions } = redact(input);
    expect(value).toBe(input);
    expect(redactions).toBe(0);
  });

  it("leaves empty and null credential values alone", () => {
    const { value, redactions } = redact({ password: "", token: null });
    expect(value).toEqual({ password: "", token: null });
    expect(redactions).toBe(0);
  });
});
