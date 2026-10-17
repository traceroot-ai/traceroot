import { describe, expect, it } from "vitest";
import { proposalDeclined } from "./proposal-declined";

const result = (details: unknown) => ({ content: [], details });

describe("proposalDeclined", () => {
  it("reads a skipped decline", () => {
    expect(proposalDeclined(result({ kind: "proposal_declined", outcome: "skipped" }))).toEqual({
      outcome: "skipped",
    });
  });

  it("reads a revised decline with its text", () => {
    expect(
      proposalDeclined(result({ kind: "proposal_declined", outcome: "revised", text: "use p95" })),
    ).toEqual({ outcome: "revised", text: "use p95" });
  });

  it("drops a non-string text rather than rendering an object", () => {
    expect(
      proposalDeclined(result({ kind: "proposal_declined", outcome: "revised", text: 7 })),
    ).toEqual({ outcome: "revised" });
  });

  it("returns null for anything that is not a decline", () => {
    expect(proposalDeclined(undefined)).toBeNull();
    expect(proposalDeclined(null)).toBeNull();
    expect(proposalDeclined("nope")).toBeNull();
    expect(proposalDeclined(result(undefined))).toBeNull();
    expect(proposalDeclined(result({}))).toBeNull();
    expect(proposalDeclined(result({ kind: "resource_created" }))).toBeNull();
    expect(proposalDeclined(result({ kind: "proposal_declined", outcome: "exploded" }))).toBeNull();
  });
});
