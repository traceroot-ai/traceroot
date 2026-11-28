import { describe, expect, it } from "vitest";
import type { KeyboardEvent } from "react";
import { isSubmitEnter } from "../keyboard";

const key = (init: { key: string; isComposing?: boolean; keyCode?: number }) =>
  ({
    key: init.key,
    nativeEvent: { isComposing: init.isComposing ?? false, keyCode: init.keyCode ?? 13 },
  }) as unknown as KeyboardEvent;

describe("isSubmitEnter", () => {
  it("accepts a plain Enter", () => {
    expect(isSubmitEnter(key({ key: "Enter" }))).toBe(true);
  });

  it("rejects an Enter that confirms IME composition", () => {
    expect(isSubmitEnter(key({ key: "Enter", isComposing: true }))).toBe(false);
    expect(isSubmitEnter(key({ key: "Enter", keyCode: 229 }))).toBe(false);
  });

  it("rejects other keys", () => {
    expect(isSubmitEnter(key({ key: "a" }))).toBe(false);
  });
});
