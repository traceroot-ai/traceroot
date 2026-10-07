import { afterEach, describe, expect, it } from "vitest";
import { internalUiUrl, publicUiUrl } from "../origins.js";

const saved = { ...process.env };
afterEach(() => {
  process.env = { ...saved };
});

describe("ui origins", () => {
  it("drops a trailing slash from the public origin so appended paths never double it", () => {
    process.env.TRACEROOT_PUBLIC_UI_URL = "https://app.example.com/";
    expect(publicUiUrl()).toBe("https://app.example.com");
    expect(`${publicUiUrl()}/projects/p1`).toBe("https://app.example.com/projects/p1");
  });

  it("falls back to the app url, then localhost, still without a trailing slash", () => {
    delete process.env.TRACEROOT_PUBLIC_UI_URL;
    process.env.NEXT_PUBLIC_APP_URL = "http://web:3000//";
    expect(publicUiUrl()).toBe("http://web:3000");
    delete process.env.NEXT_PUBLIC_APP_URL;
    expect(publicUiUrl()).toBe("http://localhost:3000");
  });

  it("treats the internal origin the same way", () => {
    process.env.TRACEROOT_UI_URL = "http://web:3000/";
    expect(internalUiUrl()).toBe("http://web:3000");
  });
});
