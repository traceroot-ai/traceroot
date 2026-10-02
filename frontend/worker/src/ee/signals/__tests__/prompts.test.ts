import { describe, expect, it } from "vitest";
import { ASSIGN_SYSTEM, UNTRUSTED_HITS, VALIDATE_SYSTEM, WRITER_SYSTEM } from "../prompts.js";

describe("assignment prompts", () => {
  it("tell every chat model that hit text is data to classify, not instructions", () => {
    for (const prompt of [ASSIGN_SYSTEM, WRITER_SYSTEM, VALIDATE_SYSTEM]) {
      expect(prompt).toContain(UNTRUSTED_HITS);
    }
  });
});
