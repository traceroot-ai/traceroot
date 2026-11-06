// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import { useViewedTraces } from "./use-viewed-traces";

/** The per-project entry the design names, spelled out rather than imported from the module
 * under test: a key the hook renames is a key every open tab loses, so it is pinned here. */
const viewedKey = (projectId = "p-1") => `traceroot:traces:viewed:v1:${projectId}`;

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(cleanup);

/** Render the hook the way the traces page wires it: a project id and nothing else. */
function renderViewed(projectId = "p-1") {
  return renderHook(() => useViewedTraces(projectId));
}

const storedIds = (projectId = "p-1") =>
  (JSON.parse(window.localStorage.getItem(viewedKey(projectId)) ?? "null")?.ids as string[]) ?? [];

describe("useViewedTraces", () => {
  it("starts with nothing viewed", () => {
    const { result } = renderViewed();
    expect([...result.current.viewedTraceIds]).toEqual([]);
  });

  it("marks a trace viewed and persists it", () => {
    const { result } = renderViewed();

    act(() => result.current.markViewed("t-1"));

    expect(result.current.viewedTraceIds.has("t-1")).toBe(true);
    expect(storedIds()).toEqual(["t-1"]);
  });

  it("moves a re-viewed trace to the front without duplicating it", () => {
    const { result } = renderViewed();

    act(() => result.current.markViewed("t-1"));
    act(() => result.current.markViewed("t-2"));
    act(() => result.current.markViewed("t-1"));

    expect(storedIds()).toEqual(["t-1", "t-2"]);
    expect([...result.current.viewedTraceIds]).toEqual(["t-1", "t-2"]);
  });

  it("keeps the stored entry unchanged when the newest trace is marked again", () => {
    // The open trace is re-marked on every selection change; writing identical bytes keeps the
    // dot clearing idempotent instead of churning storage.
    const { result } = renderViewed();
    act(() => result.current.markViewed("t-1"));
    const before = window.localStorage.getItem(viewedKey());

    act(() => result.current.markViewed("t-1"));

    expect(window.localStorage.getItem(viewedKey())).toBe(before);
  });

  it("ignores an empty trace id", () => {
    const { result } = renderViewed();

    act(() => result.current.markViewed(""));

    expect(window.localStorage.getItem(viewedKey())).toBeNull();
  });

  it("keeps each project's viewed set to itself", () => {
    const first = renderViewed();
    act(() => first.result.current.markViewed("t-1"));
    cleanup();

    const { result } = renderViewed("p-2");

    expect(result.current.viewedTraceIds.size).toBe(0);
  });

  describe("persistence", () => {
    it("restores the viewed set on the next load", () => {
      const first = renderViewed();
      act(() => first.result.current.markViewed("t-1"));
      cleanup();

      const { result } = renderViewed();

      expect(result.current.viewedTraceIds.has("t-1")).toBe(true);
    });
  });

  describe("hand-edited or stale storage", () => {
    it.each([
      ["an entry that is not an object", '"t-1"'],
      ["a bare array", JSON.stringify(["t-1"])],
      ["unparseable JSON", "{not json"],
      ["an entry whose ids is not an array", JSON.stringify({ version: 1, ids: "t-1" })],
    ])("reads %s as nothing viewed", (_case, raw) => {
      window.localStorage.setItem(viewedKey(), raw);

      const { result } = renderViewed();

      expect(result.current.viewedTraceIds.size).toBe(0);
    });

    it("reads a repeated id as one trace", () => {
      window.localStorage.setItem(
        viewedKey(),
        JSON.stringify({ version: 1, ids: ["t-1", "t-2", "t-1"] }),
      );

      const { result } = renderViewed();

      expect([...result.current.viewedTraceIds]).toEqual(["t-1", "t-2"]);
    });

    it("ignores an entry that is not an id, keeping the ones that are", () => {
      window.localStorage.setItem(
        viewedKey(),
        JSON.stringify({ version: 1, ids: ["t-1", 7, "", "t-2"] }),
      );

      const { result } = renderViewed();

      expect([...result.current.viewedTraceIds]).toEqual(["t-1", "t-2"]);
    });

    it("picks up a trace another tab marks", () => {
      const { result } = renderViewed();
      expect(result.current.viewedTraceIds.size).toBe(0);

      act(() => {
        window.localStorage.setItem(viewedKey(), JSON.stringify({ version: 1, ids: ["t-9"] }));
        window.dispatchEvent(
          new StorageEvent("storage", { key: viewedKey(), storageArea: window.localStorage }),
        );
      });

      expect(result.current.viewedTraceIds.has("t-9")).toBe(true);
    });

    it("merges a mark another tab made before this tab heard about it", () => {
      // The other tab writes to storage directly, so no `storage` event reaches this tab and its
      // state stays a version behind. Marking here must read the live entry rather than the stale
      // state, or the other tab's trace is dropped and its dot comes back.
      const { result } = renderViewed();
      window.localStorage.setItem(viewedKey(), JSON.stringify({ version: 1, ids: ["t-other"] }));

      act(() => result.current.markViewed("t-mine"));

      expect(storedIds()).toEqual(["t-mine", "t-other"]);
    });
  });
});
