// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToString } from "react-dom/server";
import { act, cleanup, renderHook } from "@testing-library/react";
import { useNow } from "./use-now";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function Clock() {
  const now = useNow();
  return <span>{now ? now.toISOString() : "no clock"}</span>;
}

describe("useNow", () => {
  it("reads no clock on the server, so hydration matches its HTML", () => {
    expect(renderToString(<Clock />)).toContain("no clock");
  });

  it("reads the clock after mount and keeps it moving", () => {
    vi.useFakeTimers({ now: new Date("2026-11-21T10:00:00Z") });
    const { result } = renderHook(() => useNow(1_000));
    expect(result.current?.toISOString()).toBe("2026-11-21T10:00:00.000Z");

    act(() => vi.advanceTimersByTime(1_000));
    expect(result.current?.toISOString()).toBe("2026-11-21T10:00:01.000Z");
  });
});
