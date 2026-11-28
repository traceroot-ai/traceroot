import { describe, expect, it } from "vitest";
import { readJsonLimited } from "./read-json-limited";

const streamed = (chunks: string[], onPull?: () => void) =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
      controller.close();
    },
    pull: onPull,
  });

describe("readJsonLimited", () => {
  it("reads a body within the limit", async () => {
    const request = new Request("http://x", { method: "PATCH", body: '{"role":"founder"}' });
    expect(await readJsonLimited(request, 100)).toEqual({ ok: true, value: { role: "founder" } });
  });

  it("refuses a body declared larger than the limit without reading it", async () => {
    const request = new Request("http://x", {
      method: "PATCH",
      body: "x".repeat(5000),
      headers: { "content-length": "5000" },
    });
    expect(await readJsonLimited(request, 100)).toMatchObject({ ok: false, status: 413 });
    expect(request.bodyUsed).toBe(false);
  });

  it("stops reading an undeclared body as soon as it passes the limit", async () => {
    const chunks = Array.from({ length: 50 }, () => "x".repeat(40));
    const request = new Request("http://x", {
      method: "PATCH",
      body: streamed(chunks),
      duplex: "half",
    } as RequestInit);
    expect(await readJsonLimited(request, 100)).toMatchObject({ ok: false, status: 413 });
  });

  it("answers 400 for a body that is not JSON", async () => {
    const request = new Request("http://x", { method: "PATCH", body: "not json" });
    expect(await readJsonLimited(request, 100)).toMatchObject({ ok: false, status: 400 });
  });
});
