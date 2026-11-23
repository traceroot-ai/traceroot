import { describe, expect, it } from "vitest";
import { caseUrlToken, findCaseByToken } from "./case-token";
import type { CaseRow } from "./model";

const row = (key: string, order: number): CaseRow => ({ key, order, byRun: new Map() });

const INPUT_KEY = `input:o:${JSON.stringify({ question: "Reset my SSO", attachments: [] })}`;
const CASES = [row("id:tc_0a1b2c", 0), row(INPUT_KEY, 1), row('input:s:"hello"', 2)];

describe("caseUrlToken", () => {
  it("keeps a case id as it is", () => {
    expect(caseUrlToken("id:tc_0a1b2c")).toBe("id:tc_0a1b2c");
  });

  it("shortens an input key to a fixed-length hash", () => {
    expect(caseUrlToken(INPUT_KEY)).toMatch(/^h:[0-9a-f]{16}$/);
    expect(caseUrlToken(`input:s:${JSON.stringify("x".repeat(5000))}`)).toMatch(/^h:[0-9a-f]{16}$/);
  });

  it("gives an input key the same token every time, so a shared link keeps working", () => {
    expect(caseUrlToken('input:s:"hello"')).toBe("h:647c12abbe33f9ac");
    expect(caseUrlToken(INPUT_KEY)).toBe(caseUrlToken(INPUT_KEY));
  });

  it("gives different inputs different tokens", () => {
    const tokens = new Set(
      Array.from({ length: 2000 }, (_, i) => caseUrlToken(`input:s:"ticket ${i}"`)),
    );
    expect(tokens.size).toBe(2000);
  });
});

describe("findCaseByToken", () => {
  it("finds a case by its id token", () => {
    expect(findCaseByToken(CASES, "id:tc_0a1b2c")).toBe(CASES[0]);
  });

  it("finds a case by its input hash", () => {
    expect(findCaseByToken(CASES, caseUrlToken(INPUT_KEY))).toBe(CASES[1]);
    expect(findCaseByToken(CASES, caseUrlToken('input:s:"hello"'))).toBe(CASES[2]);
  });

  it("finds nothing for a token no case has", () => {
    expect(findCaseByToken(CASES, "id:tc_missing")).toBeNull();
    expect(findCaseByToken(CASES, "h:0000000000000000")).toBeNull();
    expect(findCaseByToken(CASES, "")).toBeNull();
    expect(findCaseByToken(CASES, "garbage")).toBeNull();
    expect(findCaseByToken([], "id:tc_0a1b2c")).toBeNull();
  });
});
