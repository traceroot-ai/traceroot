import { describe, it, expect } from "vitest";
import { getJevTemplateCategories } from "../jev-templates.js";

describe("getJevTemplateCategories", () => {
  it("does not resolve inherited object keys", () => {
    expect(getJevTemplateCategories("toString")).toBeNull();
    expect(getJevTemplateCategories("__proto__")).toBeNull();
  });
});
