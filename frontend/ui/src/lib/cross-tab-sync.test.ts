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

afterEach(() => {
  FakeBroadcastChannel.instances = [];
  vi.unstubAllGlobals();
});

describe("isQueryInvalidationMessage", () => {
  it("accepts a well-formed message", () => {
    expect(isQueryInvalidationMessage({ type: "invalidate", queryKey: ["detectors"] })).toBe(true);
  });

  it.each([null, "invalidate", { type: "invalidate" }, { type: "other", queryKey: [] }])(
    "rejects malformed data: %j",
    (data) => {
      expect(isQueryInvalidationMessage(data)).toBe(false);
    },
  );
});

describe("broadcastQueryInvalidation", () => {
  it("posts the message on the shared channel and closes it", () => {
    vi.stubGlobal("BroadcastChannel", FakeBroadcastChannel);
    broadcastQueryInvalidation(["detectors"]);
    const channel = FakeBroadcastChannel.instances[0];
    expect(channel.name).toBe(QUERY_SYNC_CHANNEL);
    expect(channel.posted).toEqual([{ type: "invalidate", queryKey: ["detectors"] }]);
    expect(channel.closed).toBe(true);
  });

  it("is a no-op when BroadcastChannel is unavailable", () => {
    vi.stubGlobal("BroadcastChannel", undefined);
    expect(() => broadcastQueryInvalidation(["detectors"])).not.toThrow();
  });
});

describe("subscribeToQueryInvalidations", () => {
  it("invokes the callback for valid messages and ignores junk", () => {
    vi.stubGlobal("BroadcastChannel", FakeBroadcastChannel);
    const received: unknown[] = [];
    subscribeToQueryInvalidations((queryKey) => received.push(queryKey));
    const channel = FakeBroadcastChannel.instances[0];
    channel.emit({ type: "invalidate", queryKey: ["detectors"] });
    channel.emit({ unrelated: true });
    expect(received).toEqual([["detectors"]]);
  });

  it("returns an unsubscribe function that closes the channel", () => {
    vi.stubGlobal("BroadcastChannel", FakeBroadcastChannel);
    const unsubscribe = subscribeToQueryInvalidations(() => {});
    unsubscribe();
    expect(FakeBroadcastChannel.instances[0].closed).toBe(true);
  });

  it("returns a no-op unsubscribe when BroadcastChannel is unavailable", () => {
    vi.stubGlobal("BroadcastChannel", undefined);
    expect(() => subscribeToQueryInvalidations(() => {})()).not.toThrow();
  });
});
