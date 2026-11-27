import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  Agent,
  MockAgent,
  getGlobalDispatcher,
  setGlobalDispatcher,
  type Dispatcher,
} from "undici";

const dns = vi.hoisted(() => ({ lookup: vi.fn() }));
vi.mock("node:dns", () => ({ lookup: dns.lookup }));

import { InvalidProviderUrlError, installProviderNetworkPolicy } from "../provider-url.ts";

let original: Dispatcher;
let fallback: MockAgent;
beforeEach(() => {
  original = getGlobalDispatcher();
  fallback = new MockAgent();
  fallback.disableNetConnect();
  setGlobalDispatcher(fallback);
  dns.lookup.mockReset();
});
afterEach(async () => {
  vi.restoreAllMocks();
  setGlobalDispatcher(original);
  await fallback.close();
});

describe("Node SDK provider transport", () => {
  it("blocks a private Azure DNS answer in native global fetch before TCP", async () => {
    dns.lookup.mockImplementation((_host, _options, callback) =>
      callback(null, [{ address: "127.0.0.1", family: 4 }]),
    );
    installProviderNetworkPolicy();
    await expect(fetch("https://resource.openai.azure.com/openai/v1/models")).rejects.toMatchObject(
      { cause: expect.any(InvalidProviderUrlError) },
    );
    expect(dns.lookup).toHaveBeenCalledWith(
      "resource.openai.azure.com",
      { all: true },
      expect.any(Function),
    );
  });

  it("preserves the existing dispatcher for non-provider internal requests", async () => {
    fallback.get("http://agent.internal").intercept({ path: "/health" }).reply(200, "healthy");
    installProviderNetworkPolicy();
    expect(await (await fetch("http://agent.internal/health")).text()).toBe("healthy");
    expect(dns.lookup).not.toHaveBeenCalled();
  });

  it("is idempotent and installs on a replacement global dispatcher", async () => {
    installProviderNetworkPolicy();
    const installed = getGlobalDispatcher();
    installProviderNetworkPolicy();
    expect(getGlobalDispatcher()).toBe(installed);
    setGlobalDispatcher(fallback);
    installProviderNetworkPolicy();
    expect(getGlobalDispatcher()).not.toBe(fallback);
    fallback.get("http://agent.internal").intercept({ path: "/health" }).reply(200, "healthy");
    expect(await (await fetch("http://agent.internal/health")).text()).toBe("healthy");
  });

  it("preserves a successful vendor response and streaming body", async () => {
    vi.spyOn(Agent.prototype, "dispatch").mockImplementation((_options, handler) => {
      const controller: Dispatcher.DispatchController = {
        aborted: false,
        paused: false,
        reason: null,
        abort: vi.fn(),
        pause: vi.fn(),
        resume: vi.fn(),
      };
      handler.onRequestStart?.(controller, {});
      handler.onResponseStart?.(controller, 200, { "content-type": "application/json" }, "OK");
      handler.onResponseData?.(controller, Buffer.from('{"data":[]}'));
      handler.onResponseEnd?.(controller, {});
      return true;
    });
    installProviderNetworkPolicy();
    const response = await fetch("https://api.openai.com/v1/models");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ data: [] });
  });

  it("aborts a vendor redirect before native fetch can follow it to an internal service", async () => {
    fallback
      .get("http://127.0.0.1:3000")
      .intercept({ path: "/secret" })
      .reply(200, "internal-data");
    const abort = vi.fn();
    vi.spyOn(Agent.prototype, "dispatch").mockImplementation((_options, handler) => {
      let reason: Error | null = null;
      const controller: Dispatcher.DispatchController = {
        get aborted() {
          return reason !== null;
        },
        paused: false,
        get reason() {
          return reason;
        },
        pause() {},
        resume() {},
        abort(error) {
          reason = error;
          abort(error);
          handler.onResponseError?.(controller, error);
        },
      };
      handler.onRequestStart?.(controller, {});
      handler.onResponseStart?.(
        controller,
        307,
        { location: "http://127.0.0.1:3000/secret" },
        "Temporary Redirect",
      );
      return true;
    });
    installProviderNetworkPolicy();
    await expect(fetch("https://api.openai.com/v1/models")).rejects.toMatchObject({
      cause: expect.any(InvalidProviderUrlError),
    });
    expect(abort).toHaveBeenCalledWith(expect.any(InvalidProviderUrlError));
    expect(fallback.pendingInterceptors()).toHaveLength(1);
  });
});
