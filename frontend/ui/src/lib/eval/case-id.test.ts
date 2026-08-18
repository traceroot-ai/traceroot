/**
 * `stableCaseId` must stay byte-for-byte identical to the SDK derivation
 * (traceroot-ts `src/eval/ids.ts::stableCaseId`, traceroot-py
 * `traceroot/eval/ids.py::stable_case_id`) so a case authored in the UI and one
 * pushed from the SDK under the same dataset key converge on the same `tc_` id.
 *
 * The vectors below are lifted verbatim from the SDK's cross-SDK parity fixture
 * (traceroot-ts `packages/traceroot/tests/fixtures/case_id_parity.json`), which
 * BOTH SDKs assert against. Feeding each case's exact `canonical_json` (the value
 * the SDK's canonicalizer produced for that input) into our port must reproduce
 * the fixture's `id` — proving identical separators, NUL bytes, slice length, hex
 * casing, and occurrence handling.
 */
import { createHash } from "crypto";
import { describe, it, expect } from "vitest";
import { stableCaseId, nextCaseId } from "./case-id";
import { canonicalJson } from "./versions";

// dataset_key from the fixture. add()-ing these inputs IN ORDER yields these ids.
const DATASET_KEY = "weather";

// [canonical_json, expected tc_ id] in fixture order. Case index 2 is a duplicate of
// index 0, so it takes occurrence 1; every other input is unique (occurrence 0).
const VECTORS: [string, string][] = [
  ['{"n":1,"q":"a"}', "tc_0d4a8155fd3d8a4615da"],
  ["[1,2,3]", "tc_9dc099ff66e00c2888e2"],
  ['{"n":1,"q":"a"}', "tc_8066f7118c4649807c19"], // duplicate → occurrence 1
  ['{"score":1}', "tc_4a15edfa5a7b9ce61c3b"],
  ['{"a":0}', "tc_29c2fedf5b31cc205373"],
  ['{"a":2.5}', "tc_2e3d48d5036a628da770"],
  ['{"a":1e-7}', "tc_05c8278510f16bf312e6"],
  ['{"a":0.00001}', "tc_b7e2369d46cdc878c03e"],
  ['{"a":10000000000000000}', "tc_b2c299d63e147a1c74cc"],
  ['{"a":1e+21}', "tc_a3cfd7b825555f31d95e"],
  ['{"a":-1.5e-9}', "tc_4abbc789165ded5fb805"],
  ['{"f":7,"i":7}', "tc_a3f3d1129def3b43d8aa"],
  ['{"1":"c","10":"a","2":"b"}', "tc_8d0abd1fa71a2dad83d3"],
  ['{"":2,"𝄞":1}', "tc_fecdc4d7e7fc93fd45d0"],
  ['{"s":"héllo 𝄞 ünïcødé"}', "tc_900732cd2aea48ba274e"],
  ['"2020-01-01T00:00:00.000Z"', "tc_7edf45f9589f403f0b4c"],
  ['{"d":"2021-06-30T23:59:59.123Z"}', "tc_2dee231a75aa266ac648"],
  ['{"nan":"NaN","ninf":"-Infinity","pinf":"Infinity"}', "tc_9ddb24ea17182a9de720"],
  ['{"set":["B","a",1,2,3]}', "tc_b556e08d750de24d3ba7"],
  ['{"bytes":[104,105,0,255]}', "tc_3aa49e6430e3db870720"],
  ['{"a":[],"o":{},"s":[]}', "tc_98a5857d91772c37e809"],
  [
    '{"outer":{"list":[{"a":[true,null,"x"],"z":1},[2,0]],"m":{"k10":10.5,"k2":2}}}',
    "tc_875b69560cf7aa8f3485",
  ],
];

describe("stableCaseId — byte parity with the SDK", () => {
  it("reproduces every cross-SDK fixture id from its canonical input + occurrence", () => {
    const seen = new Map<string, number>();
    for (const [canonical, expectedId] of VECTORS) {
      const occurrence = seen.get(canonical) ?? 0;
      seen.set(canonical, occurrence + 1);
      expect(stableCaseId(DATASET_KEY, canonical, occurrence)).toBe(expectedId);
    }
  });

  it("uses \\x00 separators and a 20-hex-char slice (independent recomputation)", () => {
    // Recompute the SDK formula from scratch to pin separators + slice length.
    const key = "support";
    const canonical = '"hello"';
    const NUL = "\x00"; // explicit so the separator is visible in source, not an invisible byte
    const material = `${key}${NUL}${canonical}${NUL}0`;
    const expected =
      "tc_" + createHash("sha256").update(material, "utf8").digest("hex").slice(0, 20);
    expect(stableCaseId(key, canonical, 0)).toBe(expected);
    expect(stableCaseId(key, canonical, 0)).toMatch(/^tc_[0-9a-f]{20}$/);
  });

  it("disambiguates duplicate inputs by occurrence", () => {
    const a = stableCaseId("k", '"x"', 0);
    const b = stableCaseId("k", '"x"', 1);
    expect(a).not.toBe(b);
    expect(a).toBe(stableCaseId("k", '"x"', 0)); // deterministic
  });

  it("rejects a lone UTF-16 surrogate in the dataset key (parity with the SDK guard)", () => {
    expect(() => stableCaseId("\ud834", '"x"', 0)).toThrow(/surrogate/);
  });
});

describe("UI ↔ SDK convergence for the inputs the UI actually authors", () => {
  // UI case inputs are always genuine strings (CreateTestCaseRequestSchema.input), and
  // the versions.ts canonicalizer reduces a string to JSON.stringify(value) — identical
  // to the SDK's canonical form for a string — so both sides feed the SAME pre-image.
  it("a string input canonicalizes to the SDK's canonical form", () => {
    expect(canonicalJson("hello")).toBe('"hello"');
    // Same id whether the canonical string is produced by the UI canonicalizer or given.
    expect(stableCaseId("weather", canonicalJson("hello"), 0)).toBe(
      stableCaseId("weather", '"hello"', 0),
    );
  });

  it("an ASCII object input matches the SDK's sorted-key canonical form", () => {
    // Fixture case 0: input {q:"a", n:1} → canonical {"n":1,"q":"a"} → tc_0d4a8155fd3d8a4615da.
    expect(canonicalJson({ q: "a", n: 1 })).toBe('{"n":1,"q":"a"}');
    expect(stableCaseId("weather", canonicalJson({ q: "a", n: 1 }), 0)).toBe(
      "tc_0d4a8155fd3d8a4615da",
    );
  });
});

describe("nextCaseId picks the first FREE occurrence, not a count", () => {
  const key = "capitals-qa";
  const input = '{"country":"X"}'; // already-canonical input
  const id0 = stableCaseId(key, input, 0);
  const id1 = stableCaseId(key, input, 1);

  it("a brand-new input takes occurrence 0", () => {
    const r = nextCaseId(new Set<string>(), key, input);
    expect(r).toEqual({ testCaseId: id0, occurrence: 0 });
  });

  it("a duplicate of a contiguous group takes the next slot", () => {
    const r = nextCaseId(new Set([id0]), key, input);
    expect(r).toEqual({ testCaseId: id1, occurrence: 1 });
  });

  it("re-adding after the occurrence-0 case was deleted REUSES slot 0, not a collision", () => {
    // The delete-gap that a count-based occurrence gets wrong: add "X" twice (id0, id1),
    // delete id0, then add "X" again. A count would see one "X" case and mint occurrence 1
    // = id1 — a duplicate testCaseId in the same version. First-free-slot picks id0.
    const afterDeletingId0 = new Set([id1]);
    const r = nextCaseId(afterDeletingId0, key, input);
    expect(r).toEqual({ testCaseId: id0, occurrence: 0 });
    expect(afterDeletingId0.has(r.testCaseId)).toBe(false); // no collision
  });

  it("skips a legacy random id and converges on occurrence 0 (the SDK slot)", () => {
    // A legacy UI case for the same input carries a random tc_ id, never a content id.
    // The content id must still be occurrence 0 so a later SDK push of "X" upserts onto it.
    const r = nextCaseId(new Set(["tc_legacyrandomxxxxxx"]), key, input);
    expect(r).toEqual({ testCaseId: id0, occurrence: 0 });
  });
});
