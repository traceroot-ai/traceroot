// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from "vitest";
import { persistDateFilter, readPersistedDateFilter } from "./date-filter-persistence";
import { DATE_FILTER_OPTIONS, findDateFilterOption } from "./date-filter";

beforeEach(() => {
  localStorage.clear();
});

const preset = findDateFilterOption("1h");
const customOption = DATE_FILTER_OPTIONS.find((o) => o.isCustom)!;

describe("persistDateFilter / readPersistedDateFilter", () => {
  it("round-trips a preset filter", () => {
    persistDateFilter("detectors", preset, null, null);
    const restored = readPersistedDateFilter("detectors");
    expect(restored?.option.id).toBe("1h");
    expect(restored?.customStart).toBeNull();
    expect(restored?.customEnd).toBeNull();
  });

  it("round-trips a custom range with its instants", () => {
    const start = new Date("2026-06-13T00:00:00.000Z");
    const end = new Date("2026-06-14T00:00:00.000Z");
    persistDateFilter("detectors", customOption, start, end);
    const restored = readPersistedDateFilter("detectors");
    expect(restored?.option.isCustom).toBe(true);
    expect(restored?.customStart?.toISOString()).toBe("2026-06-13T00:00:00.000Z");
    expect(restored?.customEnd?.toISOString()).toBe("2026-06-14T00:00:00.000Z");
  });

  it("isolates entries by key", () => {
    persistDateFilter("detectors", preset, null, null);
    expect(readPersistedDateFilter("traces")).toBeNull();
  });

  it("returns null when nothing is stored", () => {
    expect(readPersistedDateFilter("detectors")).toBeNull();
  });

  it("returns null for malformed JSON", () => {
    localStorage.setItem("traceroot.dateFilter.detectors", "{not json");
    expect(readPersistedDateFilter("detectors")).toBeNull();
  });

  it("returns null for a payload missing an id", () => {
    localStorage.setItem("traceroot.dateFilter.detectors", JSON.stringify({ start: "x" }));
    expect(readPersistedDateFilter("detectors")).toBeNull();
  });

  it("returns null for an unknown/removed preset id instead of silently defaulting", () => {
    localStorage.setItem("traceroot.dateFilter.detectors", JSON.stringify({ id: "999z" }));
    expect(readPersistedDateFilter("detectors")).toBeNull();
  });

  it("ignores a custom entry that lost its start/end", () => {
    localStorage.setItem("traceroot.dateFilter.detectors", JSON.stringify({ id: customOption.id }));
    expect(readPersistedDateFilter("detectors")).toBeNull();
  });

  it("ignores a custom entry with unparseable dates", () => {
    localStorage.setItem(
      "traceroot.dateFilter.detectors",
      JSON.stringify({ id: customOption.id, start: "nope", end: "nope" }),
    );
    expect(readPersistedDateFilter("detectors")).toBeNull();
  });

  it("does not store custom start/end for a preset filter", () => {
    persistDateFilter("detectors", preset, new Date(), new Date());
    expect(localStorage.getItem("traceroot.dateFilter.detectors")).toBe(
      JSON.stringify({ id: "1h" }),
    );
  });
});
