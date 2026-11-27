import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LookupAddress, LookupOptions } from "node:dns";
import type { LookupFunction } from "node:net";

const network = vi.hoisted(() => ({
  dnsLookup: vi.fn(),
  socketLookup: undefined as LookupFunction | undefined,
}));
vi.mock("node:dns", () => ({ lookup: network.dnsLookup }));
vi.mock("undici", () => ({
  Agent: class {
    constructor(options: { connect: { lookup: LookupFunction } }) {
      network.socketLookup = options.connect.lookup;
    }
  },
}));

import { InvalidProviderUrlError, providerFetch, resolveProviderBaseUrl } from "../provider-url.ts";

const fetchMock = vi.fn();
beforeEach(() => {
  network.dnsLookup.mockReset();
  fetchMock.mockReset().mockResolvedValue(new Response("{}"));
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe("resolveProviderBaseUrl", () => {
  it.each([
    ["openai", "https://api.openai.com/v1"],
    ["anthropic", "https://api.anthropic.com"],
    ["google", "https://generativelanguage.googleapis.com/v1alpha"],
    ["deepseek", "https://api.deepseek.com/v1"],
    ["openrouter", "https://openrouter.ai/api/v1"],
    ["xai", "https://api.x.ai/v1"],
    ["moonshot", "https://api.moonshot.ai/v1"],
    ["zai", "https://open.bigmodel.cn/api/paas/v4"],
    ["typesafe", "https://api.typesafe.ai/v1"],
  ])("resolves the trusted default for %s", (adapter, expected) => {
    expect(resolveProviderBaseUrl(adapter)).toBe(expected);
    expect(resolveProviderBaseUrl(adapter, expected + "/")).toBe(expected);
  });

  it.each([
    "http://198.51.100.99",
    "http://127.0.0.1:3000/#",
    "http://169.254.169.254/latest/meta-data",
    "file:///etc/passwd",
    "gopher://localhost/",
    "https://127.0.0.1/v1",
    "https://[::1]/v1",
    "https://2130706433/v1",
    "https://api.openai.com.attacker.invalid/v1",
    "https://attacker.invalid/v1",
    "https://api.openai.com/v1?",
    "https://api.openai.com/v1?exfil=1",
    "https://api.openai.com/v1#",
    "https://api.openai.com/v1/#/models",
    "https://user@api.openai.com/v1",
    "https://@api.openai.com/v1",
    "https://api.openai.com:444/v1",
    "https://api.openai.com/other-path",
    " https://api.openai.com/v1",
    "https://api.openai.com/\nv1",
    "not a url",
  ])("rejects an untrusted endpoint before any network request (%s)", (url) => {
    expect(() => resolveProviderBaseUrl("openai", url)).toThrow(InvalidProviderUrlError);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(network.dnsLookup).not.toHaveBeenCalled();
  });

  it("does not allow another adapter's trusted host", () => {
    expect(() => resolveProviderBaseUrl("openai", "https://api.deepseek.com/v1")).toThrow(
      InvalidProviderUrlError,
    );
  });

  it.each([
    "https://resource.openai.azure.com",
    "https://resource.openai.azure.com/openai/v1/",
    "https://resource.services.ai.azure.com",
    "https://resource.services.ai.azure.com/openai/v1",
  ])("accepts a resource-scoped Azure endpoint (%s)", (url) => {
    expect(resolveProviderBaseUrl("azure", url)).toBe(url.replace(/\/$/, ""));
  });

  it.each([
    "https://openai.azure.com",
    "https://a.b.openai.azure.com",
    "https://resource.openai.azure.com.attacker.invalid",
    "https://-resource.openai.azure.com",
    "https://resource.openai.azure.com/private-path",
  ])("rejects Azure domain and path lookalikes (%s)", (url) => {
    expect(() => resolveProviderBaseUrl("azure", url)).toThrow(InvalidProviderUrlError);
  });

  it("leaves Bedrock endpoint selection to the AWS SDK, ignoring stale URL fields", () => {
    expect(resolveProviderBaseUrl("amazon-bedrock")).toBeUndefined();
    expect(resolveProviderBaseUrl("amazon-bedrock", "https://api.openai.com/v1")).toBeUndefined();
    expect(resolveProviderBaseUrl("amazon-bedrock", "http://127.0.0.1:3000/#")).toBeUndefined();
    expect(() => resolveProviderBaseUrl("azure")).toThrow(InvalidProviderUrlError);
    expect(() => resolveProviderBaseUrl("unknown-adapter")).toThrow(InvalidProviderUrlError);
  });
});

function lookupAddress(options: LookupOptions = { all: true }): Promise<LookupAddress[]> {
  return new Promise((resolve, reject) => {
    network.socketLookup!("api.openai.com", options, (error, address, family) => {
      if (error) return reject(error);
      resolve(typeof address === "string" ? [{ address, family: family! }] : address);
    });
  });
}
function dnsAnswers(addresses: LookupAddress[]) {
  network.dnsLookup.mockImplementation((_hostname, _options, callback) =>
    callback(null, addresses),
  );
}

describe("providerFetch", () => {
  it("forces the secure dispatcher and refuses HTTP redirects", async () => {
    await providerFetch("https://api.openai.com/v1/models", {
      redirect: "follow",
      headers: { Authorization: "Bearer SENTINEL" },
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.openai.com/v1/models",
      expect.objectContaining({
        redirect: "error",
        dispatcher: expect.any(Object),
        headers: { Authorization: "Bearer SENTINEL" },
      }),
    );
  });

  it.each([
    "http://127.0.0.1:3000/#",
    "https://127.0.0.1",
    "https://attacker.invalid",
    "https://api.openai.com/v1#",
  ])("rejects a transport bypass without calling fetch (%s)", async (url) => {
    await expect(providerFetch(url, {})).rejects.toThrow(InvalidProviderUrlError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("allows request query parameters for an approved Azure API", async () => {
    await providerFetch(
      "https://resource.openai.azure.com/openai/models?api-version=2024-10-21",
      {},
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    "0.0.0.0",
    "10.1.2.3",
    "100.64.0.1",
    "127.0.0.1",
    "169.254.169.254",
    "172.16.0.1",
    "192.0.0.1",
    "192.0.2.1",
    "192.88.99.1",
    "192.168.1.1",
    "198.18.0.1",
    "198.51.100.99",
    "203.0.113.1",
    "224.0.0.1",
    "240.0.0.1",
  ])("rejects a special-use IPv4 answer at connection time (%s)", async (address) => {
    dnsAnswers([{ address, family: 4 }]);
    await expect(lookupAddress()).rejects.toThrow(InvalidProviderUrlError);
  });

  it.each([
    "::",
    "::1",
    "::ffff:127.0.0.1",
    "fc00::1",
    "fe80::1",
    "ff02::1",
    "2001::1",
    "2001:db8::1",
    "2002::1",
    "3fff::1",
  ])("rejects a non-public IPv6 answer at connection time (%s)", async (address) => {
    dnsAnswers([{ address, family: 6 }]);
    await expect(lookupAddress()).rejects.toThrow(InvalidProviderUrlError);
  });

  it("returns public answers without allowing the socket to resolve the hostname again", async () => {
    const answers = [
      { address: "8.8.8.8", family: 4 },
      { address: "2606:4700::1111", family: 6 },
    ];
    dnsAnswers(answers);
    expect(await lookupAddress()).toEqual(answers);
    expect(await lookupAddress({ family: 6 })).toEqual([{ address: "2606:4700::1111", family: 6 }]);
    expect(network.dnsLookup).toHaveBeenCalledWith(
      "api.openai.com",
      { all: true },
      expect.any(Function),
    );
  });

  it("rejects a mixed public/private answer rather than selecting only its first address", async () => {
    dnsAnswers([
      { address: "8.8.8.8", family: 4 },
      { address: "::1", family: 6 },
    ]);
    await expect(lookupAddress()).rejects.toThrow(InvalidProviderUrlError);
  });

  it("checks fresh DNS answers when a later socket connection would rebind", async () => {
    dnsAnswers([{ address: "8.8.8.8", family: 4 }]);
    expect(await lookupAddress()).toEqual([{ address: "8.8.8.8", family: 4 }]);
    dnsAnswers([{ address: "127.0.0.1", family: 4 }]);
    const sendRequest = vi.fn();
    fetchMock.mockImplementation(async () => {
      await lookupAddress();
      sendRequest();
      return new Response("{}");
    });
    await expect(providerFetch("https://api.openai.com/v1/models", {})).rejects.toThrow(
      InvalidProviderUrlError,
    );
    expect(sendRequest).not.toHaveBeenCalled();
  });

  it("fails closed for empty DNS results and an unavailable requested family", async () => {
    dnsAnswers([]);
    await expect(lookupAddress()).rejects.toThrow(InvalidProviderUrlError);
    dnsAnswers([{ address: "8.8.8.8", family: 4 }]);
    await expect(lookupAddress({ family: 6 })).rejects.toThrow(InvalidProviderUrlError);
  });

  it("propagates DNS lookup failure without starting a request", async () => {
    network.dnsLookup.mockImplementation((_host, _opts, callback) =>
      callback(new Error("DNS unavailable")),
    );
    await expect(lookupAddress()).rejects.toThrow("DNS unavailable");
  });
});
