import { describe, expect, it } from "vitest";
import {
  addViewedTrace,
  MAX_VIEWED_TRACES,
  mergeViewedTrace,
  normalizeViewedTraces,
  toStoredViewedTraces,
  viewedTracesKey,
} from "./viewed-storage";

describe("viewedTracesKey", () => {
  it("names the project in a versioned key", () => {
    // Spelled out rather than derived: a key the module renames is a key every open tab loses.
    expect(viewedTracesKey("p-1")).toBe("traceroot:traces:viewed:v1:p-1");
  });
});

describe("normalizeViewedTraces", () => {
  it("reads nothing viewed from anything that is not a stored entry", () => {
    for (const raw of [null, undefined, false, 7, "t-1", ["t-1"]]) {
      expect(normalizeViewedTraces(raw)).toEqual([]);
    }
  });

  it("keeps order, dedupes first-wins, and drops entries that are not ids", () => {
    expect(
      normalizeViewedTraces({ version: 1, ids: ["t-2", "t-1", "t-2", 7, "", null, "t-1"] }),
    ).toEqual(["t-2", "t-1"]);
  });

  it("caps at MAX_VIEWED_TRACES keeping the front of the list", () => {
    const ids = Array.from({ length: MAX_VIEWED_TRACES + 5 }, (_, i) => `t-${i}`);
    const normalized = normalizeViewedTraces({ version: 1, ids });
    expect(normalized).toHaveLength(MAX_VIEWED_TRACES);
    expect(normalized[0]).toBe("t-0");
    expect(normalized.at(-1)).toBe(`t-${MAX_VIEWED_TRACES - 1}`);
  });
});

describe("addViewedTrace", () => {
  it("puts a new id at the front", () => {
    expect(addViewedTrace(["t-1"], "t-2")).toEqual(["t-2", "t-1"]);
  });

  it("moves a seen id to the front without duplicating it", () => {
    expect(addViewedTrace(["t-1", "t-2"], "t-2")).toEqual(["t-2", "t-1"]);
  });

  it("leaves the list alone for an empty id", () => {
    expect(addViewedTrace(["t-1"], "")).toEqual(["t-1"]);
  });

  it("caps the list, dropping the oldest viewing", () => {
    const full = Array.from({ length: MAX_VIEWED_TRACES }, (_, i) => `t-${i}`);
    const next = addViewedTrace(full, "new");
    expect(next).toHaveLength(MAX_VIEWED_TRACES);
    expect(next[0]).toBe("new");
    expect(next).not.toContain(`t-${MAX_VIEWED_TRACES - 1}`);
  });
});

describe("toStoredViewedTraces", () => {
  it("stamps the version and copies the ids rather than aliasing the caller's list", () => {
    const ids = ["t-1", "t-2"];
    const stored = toStoredViewedTraces(ids);
    expect(stored).toEqual({ version: 1, ids: ["t-1", "t-2"] });
    expect(stored.ids).not.toBe(ids);
  });
});

describe("mergeViewedTrace", () => {
  function fakeStorage(initial: string[]) {
    let value = [...initial];
    return {
      read: () => [...value],
      write: (ids: string[]) => {
        value = [...ids];
      },
      snapshot: () => [...value],
    };
  }

  it("adds the trace and writes it", () => {
    const storage = fakeStorage([]);
    expect(mergeViewedTrace(storage, "t-1")).toEqual(["t-1"]);
    expect(storage.snapshot()).toEqual(["t-1"]);
  });

  it("returns the current list without writing when the trace is already newest", () => {
    const storage = fakeStorage(["t-1"]);
    expect(mergeViewedTrace(storage, "t-1")).toEqual(["t-1"]);
    expect(storage.snapshot()).toEqual(["t-1"]);
  });

  it("merges back a trace another tab wrote between the write and the re-read", () => {
    // The competitor overwrites storage once, right after our first write, standing in for a tab
    // that raced us. The bounded re-read has to union both traces rather than let one drop.
    let value = ["t-other"];
    let competitor: string[] | null = ["t-other", "t-other-2"];
    const storage = {
      read: () => [...value],
      write: (ids: string[]) => {
        value = [...ids];
        if (competitor) {
          value = competitor;
          competitor = null;
        }
      },
    };

    expect(mergeViewedTrace(storage, "t-mine")).toEqual(["t-other", "t-other-2", "t-mine"]);
    expect(value).toEqual(["t-other", "t-other-2", "t-mine"]);
  });
});
