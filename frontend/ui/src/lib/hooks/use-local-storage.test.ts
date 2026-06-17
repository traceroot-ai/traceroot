import { afterEach, describe, expect, it } from "vitest";
import { readStored, writeStored } from "./use-local-storage";

// Minimal in-memory Storage stand-in (env is "node", so there is no real window).
function makeStorage(initial: Record<string, string> = {}): Storage {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (k: string) => (data.has(k) ? (data.get(k) as string) : null),
    setItem: (k: string, v: string) => {
      data.set(k, v);
    },
    removeItem: (k: string) => {
      data.delete(k);
    },
    clear: () => data.clear(),
    key: (i: number) => Array.from(data.keys())[i] ?? null,
    get length() {
      return data.size;
    },
  } as Storage;
}

// The hook reads `window.localStorage`; in the node test env we install a fake
// `window` on globalThis (a bare `window` reference resolves to globalThis.window).
function setWindow(storage: Storage | undefined): void {
  (globalThis as unknown as { window?: { localStorage: Storage } }).window = storage
    ? { localStorage: storage }
    : undefined;
}

afterEach(() => {
  delete (globalThis as unknown as { window?: unknown }).window;
});

describe("readStored", () => {
  it("returns the fallback when window/localStorage is unavailable (SSR)", () => {
    setWindow(undefined);
    expect(readStored("k", false)).toBe(false);
  });

  it("returns the fallback when the key is absent", () => {
    setWindow(makeStorage());
    expect(readStored("missing", "fallback")).toBe("fallback");
  });

  it("parses and returns a stored value", () => {
    setWindow(makeStorage({ k: JSON.stringify(true) }));
    expect(readStored("k", false)).toBe(true);
  });

  it("returns the fallback on malformed JSON", () => {
    setWindow(makeStorage({ k: "{not json" }));
    expect(readStored("k", 42)).toBe(42);
  });

  it("returns the fallback when getItem throws (private mode)", () => {
    const throwing = {
      getItem: () => {
        throw new Error("blocked");
      },
    } as unknown as Storage;
    setWindow(throwing);
    expect(readStored("k", "safe")).toBe("safe");
  });
});

describe("writeStored", () => {
  it("persists a JSON-serialized value", () => {
    const storage = makeStorage();
    setWindow(storage);
    writeStored("k", true);
    expect(storage.getItem("k")).toBe(JSON.stringify(true));
  });

  it("does not throw when storage is unavailable (SSR)", () => {
    setWindow(undefined);
    expect(() => writeStored("k", true)).not.toThrow();
  });

  it("does not throw when setItem throws (quota/private mode)", () => {
    const throwing = {
      setItem: () => {
        throw new Error("quota");
      },
    } as unknown as Storage;
    setWindow(throwing);
    expect(() => writeStored("k", true)).not.toThrow();
  });
});
