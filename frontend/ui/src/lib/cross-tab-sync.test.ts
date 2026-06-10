import { afterEach, describe, expect, it, vi } from "vitest";
import {
  QUERY_SYNC_CHANNEL,
  isQueryInvalidationMessage,
  broadcastQueryInvalidation,
  subscribeToQueryInvalidations,
} from "./cross-tab-sync";

class FakeBroadcastChannel {
  static instances: FakeBroadcastChannel[] = [];
  name: string;
  posted: unknown[] = [];
  closed = false;
  private listeners: Array<(e: MessageEvent) => void> = [];

  constructor(name: string) {
    this.name = name;
    FakeBroadcastChannel.instances.push(this);
  }
  postMessage(data: unknown) {
    this.posted.push(data);
  }
  addEventListener(_type: string, listener: (e: MessageEvent) => void) {
    this.listeners.push(listener);
  }
  close() {
    this.closed = true;
  }
  emit(data: unknown) {
    for (const listener of this.listeners) listener({ data } as MessageEvent);
  }
}

// The implementation no-ops outside the browser (Node also has a global
// BroadcastChannel), so active-path tests must stub `window` alongside the
// fake channel.
function stubBrowserEnvironment() {
  vi.stubGlobal("window", {});
  vi.stubGlobal("BroadcastChannel", FakeBroadcastChannel);
}

afterEach(() => {
  FakeBroadcastChannel.instances = [];
  vi.unstubAllGlobals();
});

describe("isQueryInvalidationMessage", () => {
  it("accepts a well-formed message", () => {
    expect(isQueryInvalidationMessage({ type: "invalidate", queryKey: ["detectors"] })).toBe(true);
  });

  it.each([
    null,
    "invalidate",
    { type: "invalidate" },
    { type: "other", queryKey: ["detectors"] },
    { type: "invalidate", queryKey: [] },
  ])("rejects malformed data: %j", (data) => {
    expect(isQueryInvalidationMessage(data)).toBe(false);
  });
});

describe("broadcastQueryInvalidation", () => {
  it("posts the message on the shared channel and closes it", () => {
    stubBrowserEnvironment();
    broadcastQueryInvalidation(["detectors"]);
    const channel = FakeBroadcastChannel.instances[0];
    expect(channel.name).toBe(QUERY_SYNC_CHANNEL);
    expect(channel.posted).toEqual([{ type: "invalidate", queryKey: ["detectors"] }]);
    expect(channel.closed).toBe(true);
  });

  it("is a no-op when BroadcastChannel is unavailable", () => {
    vi.stubGlobal("window", {});
    vi.stubGlobal("BroadcastChannel", undefined);
    expect(() => broadcastQueryInvalidation(["detectors"])).not.toThrow();
  });

  it("does not open a channel outside the browser even when BroadcastChannel exists", () => {
    vi.stubGlobal("BroadcastChannel", FakeBroadcastChannel);
    broadcastQueryInvalidation(["detectors"]);
    expect(FakeBroadcastChannel.instances).toHaveLength(0);
  });

  it("swallows a throwing channel constructor", () => {
    vi.stubGlobal("window", {});
    vi.stubGlobal(
      "BroadcastChannel",
      class {
        constructor() {
          throw new Error("denied");
        }
      },
    );
    expect(() => broadcastQueryInvalidation(["detectors"])).not.toThrow();
  });
});

describe("subscribeToQueryInvalidations", () => {
  it("invokes the callback for valid messages and ignores junk", () => {
    stubBrowserEnvironment();
    const received: unknown[] = [];
    subscribeToQueryInvalidations((queryKey) => received.push(queryKey));
    const channel = FakeBroadcastChannel.instances[0];
    channel.emit({ type: "invalidate", queryKey: ["detectors"] });
    channel.emit({ unrelated: true });
    expect(received).toEqual([["detectors"]]);
  });

  it("returns an unsubscribe function that closes the channel", () => {
    stubBrowserEnvironment();
    const unsubscribe = subscribeToQueryInvalidations(() => {});
    unsubscribe();
    expect(FakeBroadcastChannel.instances[0].closed).toBe(true);
  });

  it("returns a no-op unsubscribe when BroadcastChannel is unavailable", () => {
    vi.stubGlobal("window", {});
    vi.stubGlobal("BroadcastChannel", undefined);
    expect(() => subscribeToQueryInvalidations(() => {})()).not.toThrow();
  });

  it("returns a no-op unsubscribe when the channel constructor throws", () => {
    vi.stubGlobal("window", {});
    vi.stubGlobal(
      "BroadcastChannel",
      class {
        constructor() {
          throw new Error("denied");
        }
      },
    );
    expect(() => subscribeToQueryInvalidations(() => {})()).not.toThrow();
  });
});
