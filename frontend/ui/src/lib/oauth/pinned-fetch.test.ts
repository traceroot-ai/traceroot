import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { METADATA_MAX_HEADER_BYTES, pinnedMetadataFetch } from "./pinned-fetch";

type Options = Record<string, any>;

/** A fake https.request that answers with `status`, `headers` and `body`. */
function fakeRequest(status = 200, headers: Record<string, string> = {}, body = "{}") {
  const calls: { url: URL; options: Options }[] = [];
  const request = vi.fn((url: URL, options: Options, onResponse: (r: unknown) => void) => {
    calls.push({ url, options });
    const outgoing = new EventEmitter() as EventEmitter & { end: () => void };
    outgoing.end = () => {
      const response = Object.assign(new PassThrough(), {
        statusCode: status,
        statusMessage: "OK",
        headers,
      });
      response.end(body);
      onResponse(response);
    };
    return outgoing;
  });
  return { request: request as never, calls };
}

const publicDns = vi.fn(async () => [{ address: "104.18.0.1", family: 4 }]);

describe("the metadata document transport", () => {
  it("accepts large response headers, pins the checked address and keeps the hostname", async () => {
    const { request, calls } = fakeRequest(200, { "set-cookie": "x".repeat(20_000) }, '{"a":1}');
    const fetchDoc = pinnedMetadataFetch({ lookup: publicDns as never, request });
    const response = await fetchDoc("https://cursor.example/oauth/client.json");

    expect(await response.json()).toEqual({ a: 1 });
    const { options } = calls[0];
    expect(options.maxHeaderSize).toBe(METADATA_MAX_HEADER_BYTES);
    expect(METADATA_MAX_HEADER_BYTES).toBe(65_536);
    expect(options.headers.host).toBe("cursor.example");
    expect(options.servername).toBe("cursor.example");
    const pinned = vi.fn();
    options.lookup("cursor.example", { all: true }, pinned);
    expect(pinned).toHaveBeenCalledWith(null, [{ address: "104.18.0.1", family: 4 }]);
    options.lookup("cursor.example", {}, pinned);
    expect(pinned).toHaveBeenLastCalledWith(null, "104.18.0.1", 4);
  });

  it("returns a redirect instead of following it", async () => {
    const { request, calls } = fakeRequest(302, { location: "https://elsewhere.example/" }, "");
    const response = await pinnedMetadataFetch({ lookup: publicDns as never, request })(
      "https://cursor.example/doc",
    );
    expect(response.status).toBe(302);
    expect(calls).toHaveLength(1);
  });

  it.each([
    ["plain http", "http://cursor.example/doc", {}],
    ["a POST", "https://cursor.example/doc", { method: "POST" }],
  ])("refuses %s", async (_label, url, init) => {
    const { request } = fakeRequest();
    await expect(
      pinnedMetadataFetch({ lookup: publicDns as never, request })(url, init),
    ).rejects.toThrow(TypeError);
  });

  it("refuses a host with any private DNS answer, before connecting", async () => {
    const { request, calls } = fakeRequest();
    const lookup = vi.fn(async () => [
      { address: "104.18.0.1", family: 4 },
      { address: "10.0.0.5", family: 4 },
    ]);
    await expect(
      pinnedMetadataFetch({ lookup: lookup as never, request })("https://rebind.example/doc"),
    ).rejects.toThrow("public-routable");
    expect(calls).toHaveLength(0);
  });
});
