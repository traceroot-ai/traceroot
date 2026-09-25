// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { useEffect } from "react";
import { act, renderHook } from "@testing-library/react";
import { useLocalStorage, writeStored } from "./use-local-storage";

afterEach(() => {
  window.localStorage.clear();
});

describe("useLocalStorage", () => {
  it("adopts the stored value after mount and persists writes", () => {
    writeStored("k1", "stored");
    const { result } = renderHook(() => useLocalStorage("k1", "default"));
    expect(result.current[0]).toBe("stored");
    act(() => result.current[1]("next"));
    expect(window.localStorage.getItem("k1")).toBe(JSON.stringify("next"));
  });

  it("never commits the old key's value under a new key", () => {
    // A consumer that reacts to the value in an effect (and may write it back)
    // must not observe key B paired with key A's value, even for one commit.
    writeStored("a", "A-value");
    writeStored("b", "B-value");
    const seen: Array<[string, string]> = [];
    const { rerender } = renderHook(
      ({ key }) => {
        const [value] = useLocalStorage(key, "default");
        useEffect(() => {
          seen.push([key, value]);
        }, [key, value]);
        return value;
      },
      { initialProps: { key: "a" } },
    );
    rerender({ key: "b" });
    expect(seen.filter(([key]) => key === "b").map(([, v]) => v)).toEqual(
      expect.arrayContaining(["B-value"]),
    );
    expect(seen).not.toContainEqual(["b", "A-value"]);
  });
});
