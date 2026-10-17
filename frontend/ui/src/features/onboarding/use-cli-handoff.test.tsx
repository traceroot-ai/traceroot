// @vitest-environment jsdom
/**
 * The handoff's life in an open tab: minted once, replaced before it expires,
 * and silent about every way that can fail.
 *
 * Fake timers throughout, because the whole of this hook is one timer and the
 * question is when it fires. testing-library's `waitFor` polls on real ones, so
 * the microtask queue is drained by hand instead.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";

const mocks = vi.hoisted(() => ({
  createCliHandoff: vi.fn(),
}));

vi.mock("@/lib/api/cli-handoff", () => ({
  createCliHandoff: (projectId: string) => mocks.createCliHandoff(projectId),
}));

import { HANDOFF_MIN_REFRESH_MS, HANDOFF_REFRESH_LEAD_MS, useCliHandoff } from "./use-cli-handoff";

/** The contracted lifetime: `POST /api/cli/handoff` answers `expiresIn: 600`. */
const LIFETIME_SECONDS = 600;
const LIFETIME_MS = LIFETIME_SECONDS * 1000;

function handoff(code: string, expiresIn: number = LIFETIME_SECONDS) {
  return {
    code,
    expiresIn,
    expiresAt: new Date(Date.now() + expiresIn * 1000).toISOString(),
  };
}

/** Drain the microtask queue; the mint is several awaits deep. */
async function flush() {
  await act(async () => {
    for (let turn = 0; turn < 10; turn += 1) {
      await Promise.resolve();
    }
  });
}

async function advance(ms: number) {
  await act(async () => {
    vi.advanceTimersByTime(ms);
  });
  await flush();
}

beforeEach(() => {
  vi.useFakeTimers();
  mocks.createCliHandoff.mockResolvedValue(handoff("trh_first"));
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  mocks.createCliHandoff.mockReset();
});

describe("useCliHandoff", () => {
  it("mints for the project as soon as there is one", async () => {
    // Which is the moment the hand-back step first renders: the page sets the
    // created project and this runs off the same render.
    const { result } = renderHook(() => useCliHandoff("proj-1"));
    // Nothing to show before the round trip lands, and the step prints the
    // working command meanwhile.
    expect(result.current).toBeNull();

    await flush();

    expect(mocks.createCliHandoff).toHaveBeenCalledWith("proj-1");
    expect(result.current).toBe("trh_first");
  });

  it("mints nothing until the project exists", async () => {
    // A page the user abandons on the form has cost the mint nothing, and
    // there is no project to record a handoff against in any case.
    const { result, rerender } = renderHook(({ id }: { id: string | null }) => useCliHandoff(id), {
      initialProps: { id: null as string | null },
    });
    await flush();

    expect(mocks.createCliHandoff).not.toHaveBeenCalled();
    expect(result.current).toBeNull();

    rerender({ id: "proj-1" });
    await flush();

    expect(mocks.createCliHandoff).toHaveBeenCalledWith("proj-1");
    expect(result.current).toBe("trh_first");
  });

  it("replaces the code shortly before it expires", async () => {
    // A tab left open outlives any one code. The replacement arrives inside
    // the old code's life, so the line on screen is never briefly dead.
    const { result } = renderHook(() => useCliHandoff("proj-1"));
    await flush();
    mocks.createCliHandoff.mockResolvedValue(handoff("trh_second"));

    // One tick short of the lead: still the first code.
    await advance(LIFETIME_MS - HANDOFF_REFRESH_LEAD_MS - 1);
    expect(result.current).toBe("trh_first");

    await advance(1);

    expect(mocks.createCliHandoff).toHaveBeenCalledTimes(2);
    expect(result.current).toBe("trh_second");
  });

  it("keeps replacing it for as long as the tab is open", async () => {
    const { result } = renderHook(() => useCliHandoff("proj-1"));
    await flush();

    for (const code of ["trh_second", "trh_third", "trh_fourth"]) {
      mocks.createCliHandoff.mockResolvedValue(handoff(code));
      await advance(LIFETIME_MS - HANDOFF_REFRESH_LEAD_MS);
      expect(result.current).toBe(code);
    }
    expect(mocks.createCliHandoff).toHaveBeenCalledTimes(4);
  });

  it("hands back nothing when the mint fails, and does not retry", async () => {
    // The command without `--handoff` is what this page printed before
    // handoffs existed and it works, so a failure degrades to it. Asking an
    // unreachable endpoint again every few seconds would buy nothing.
    mocks.createCliHandoff.mockRejectedValue(new Error("network"));
    const { result } = renderHook(() => useCliHandoff("proj-1"));
    await flush();

    expect(result.current).toBeNull();

    await advance(LIFETIME_MS * 2);

    expect(result.current).toBeNull();
    expect(mocks.createCliHandoff).toHaveBeenCalledTimes(1);
  });

  it("keeps a still-live code when its replacement fails, then drops it", async () => {
    // The replacement failing does not make the code in hand invalid — it has
    // the lead time left on it, and a user who pastes inside that window still
    // skips the browser page. Once it is genuinely expired, the line goes back
    // to the unaided command rather than printing something dead.
    const { result } = renderHook(() => useCliHandoff("proj-1"));
    await flush();
    mocks.createCliHandoff.mockRejectedValue(new Error("network"));

    await advance(LIFETIME_MS - HANDOFF_REFRESH_LEAD_MS);
    expect(mocks.createCliHandoff).toHaveBeenCalledTimes(2);
    expect(result.current).toBe("trh_first");

    await advance(HANDOFF_REFRESH_LEAD_MS);

    expect(result.current).toBeNull();
    // Still no retry after the drop.
    expect(mocks.createCliHandoff).toHaveBeenCalledTimes(2);
  });

  it("stops dead on unmount", async () => {
    // A tab closed mid-flow must not go on minting credentials for a page
    // nobody is on, and must not set state after it is gone.
    const { unmount } = renderHook(() => useCliHandoff("proj-1"));
    await flush();
    expect(mocks.createCliHandoff).toHaveBeenCalledTimes(1);

    unmount();
    await advance(LIFETIME_MS * 3);

    expect(mocks.createCliHandoff).toHaveBeenCalledTimes(1);
  });

  it("discards a mint that lands after the unmount", async () => {
    // The round trip outlives the tab that asked for it often enough — closing
    // the page during it is the ordinary case, not an edge.
    let land: (value: ReturnType<typeof handoff>) => void = () => {};
    mocks.createCliHandoff.mockReturnValue(
      new Promise((resolve) => {
        land = resolve;
      }),
    );
    const { unmount } = renderHook(() => useCliHandoff("proj-1"));
    unmount();

    land(handoff("trh_late"));
    await flush();
    await advance(LIFETIME_MS);

    // Nothing scheduled off the late answer, and no second mint.
    expect(mocks.createCliHandoff).toHaveBeenCalledTimes(1);
  });

  it("shows a code whose lifetime the route did not state, and plans nothing", async () => {
    // Defensive rather than expected: the contract says `expiresIn: 600`. A
    // lifetime this page cannot read is no reason to withhold a code that may
    // well work — it is a reason not to guess when to replace it, because a
    // guess of zero is a loop against the endpoint.
    mocks.createCliHandoff.mockResolvedValue({
      code: "trh_unstated",
      expiresIn: 0,
      expiresAt: "",
    });
    const { result } = renderHook(() => useCliHandoff("proj-1"));
    await flush();

    expect(result.current).toBe("trh_unstated");

    await advance(LIFETIME_MS * 2);

    expect(mocks.createCliHandoff).toHaveBeenCalledTimes(1);
    expect(result.current).toBe("trh_unstated");
  });

  it("will not re-mint faster than the floor when the route states a short life", async () => {
    // Defensive, like the case above: the contract is `expiresIn: 600`. A
    // lifetime inside the lead would schedule the replacement almost at once,
    // and since the route would answer the same short life again, that is a
    // loop against the endpoint for as long as the tab is open. The floor is
    // what holds the gap open instead.
    const UNCLAMPED_GAP_MS = 10_000;
    // Guards the fixture, not the hook: if the floor ever drops below the gap
    // the lead alone would leave, the rest of this test stops exercising it.
    expect(UNCLAMPED_GAP_MS).toBeLessThan(HANDOFF_MIN_REFRESH_MS);
    const shortLifetimeSeconds = (HANDOFF_REFRESH_LEAD_MS + UNCLAMPED_GAP_MS) / 1000;
    mocks.createCliHandoff.mockResolvedValue(handoff("trh_short", shortLifetimeSeconds));

    const { result } = renderHook(() => useCliHandoff("proj-1"));
    await flush();
    expect(result.current).toBe("trh_short");

    // Well past the moment the lead on its own would have fired, and still
    // one tick inside the floor.
    await advance(HANDOFF_MIN_REFRESH_MS - 1);
    expect(mocks.createCliHandoff).toHaveBeenCalledTimes(1);

    await advance(1);
    expect(mocks.createCliHandoff).toHaveBeenCalledTimes(2);
  });
});
