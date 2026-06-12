// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { CrossTabQuerySync } from "./cross-tab-query-sync";

class FakeBroadcastChannel {
  static instances: FakeBroadcastChannel[] = [];
  name: string;
  closed = false;
  private listeners: Array<(e: MessageEvent) => void> = [];

  constructor(name: string) {
    this.name = name;
    FakeBroadcastChannel.instances.push(this);
  }
  postMessage() {}
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
  cleanup();
  FakeBroadcastChannel.instances = [];
  vi.unstubAllGlobals();
});

function renderSync() {
  vi.stubGlobal("BroadcastChannel", FakeBroadcastChannel);
  const queryClient = new QueryClient();
  const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");
  const view = render(
    <QueryClientProvider client={queryClient}>
      <CrossTabQuerySync />
    </QueryClientProvider>,
  );
  return { invalidateSpy, view };
}

describe("CrossTabQuerySync", () => {
  it("invalidates the query key received from another tab", () => {
    const { invalidateSpy } = renderSync();
    const channel = FakeBroadcastChannel.instances.at(-1)!;
    channel.emit({ type: "invalidate", queryKey: ["detectors"] });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["detectors"] });
  });

  it("ignores malformed messages", () => {
    const { invalidateSpy } = renderSync();
    const channel = FakeBroadcastChannel.instances.at(-1)!;
    channel.emit({ type: "other" });
    expect(invalidateSpy).not.toHaveBeenCalled();
  });

  it("closes the channel on unmount", () => {
    const { view } = renderSync();
    const channel = FakeBroadcastChannel.instances.at(-1)!;
    view.unmount();
    expect(channel.closed).toBe(true);
  });
});
