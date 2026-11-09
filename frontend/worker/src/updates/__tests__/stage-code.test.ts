import { describe, expect, it } from "vitest";
import type { UpdateResult } from "@traceroot/core/updates";
import type { CodeChangesReport } from "../code/code-changes.js";
import { codeReportProblems } from "../stage.js";

const result = (text: string): UpdateResult => ({
  nothingToReport: false,
  headline: "h",
  summary: "",
  sections: [
    {
      id: "code_changes",
      title: "Code",
      items: [
        { text, evidence: [{ kind: "pull_request", label: "p", url: "http://a.example.com/p" }] },
      ],
    },
  ],
  suggestedDetectors: [],
  notesForNextRun: "",
});
const base: CodeChangesReport = {
  status: "ready",
  repo: "a/b",
  hasGitContext: true,
  method: "ref_split",
  methodNote: "",
  clone: { mode: "clone", note: "" },
  items: [],
  commits: [],
  excerpts: [],
  notes: [],
};

describe("codeReportProblems", () => {
  it("wants the missing git context said", () => {
    const report = { ...base, status: "no_git_context" as const };
    expect(codeReportProblems(result("Nothing to join."), report).join(" ")).toContain(
      "no git context",
    );
    expect(
      codeReportProblems(
        result("The traces carry no git context, so changes are not joined."),
        report,
      ),
    ).toEqual([]);
  });

  it("wants a repository that is not on the list said", () => {
    const report = { ...base, status: "not_allowed" as const };
    expect(codeReportProblems(result("Code was skipped."), report).length).toBe(1);
    expect(
      codeReportProblems(
        result("The repository is not on this project's list, so no code was read."),
        report,
      ),
    ).toEqual([]);
  });

  it("wants a fallback stated in the words of the report, never silent", () => {
    const report = {
      ...base,
      clone: {
        mode: "api_only" as const,
        fallbackReason: "timeout" as const,
        note: "Code diffs unavailable this period: the clone timed out; showing pull request and release metadata only.",
      },
    };
    expect(codeReportProblems(result("PR #101 merged."), report).join(" ")).toContain(
      "Code diffs unavailable this period",
    );
    expect(
      codeReportProblems(
        result("Code diffs unavailable this period: the clone timed out."),
        report,
      ),
    ).toEqual([]);
  });

  it("wants each change that coincides with a shift named", () => {
    const report = {
      ...base,
      items: [
        {
          kind: "pull_request" as const,
          label: "PR #101",
          title: "t",
          at: "x",
          url: "u",
          sha: "s",
          files: [],
          traffic: null,
          fileTraffic: [],
          evidence: "Traces failed more.",
        },
        {
          kind: "release" as const,
          label: "release v1.4.0",
          title: "t",
          at: "x",
          url: "u",
          sha: "s",
          files: [],
          traffic: null,
          fileTraffic: [],
          evidence: "Traces failed more.",
        },
      ],
    };
    expect(codeReportProblems(result("Something merged."), report).length).toBe(2);
    expect(
      codeReportProblems(result("PR #101 and release v1.4.0 coincide with the rise."), report),
    ).toEqual([]);
  });

  it("asks nothing when there is nothing to report", () => {
    const quiet = { ...result("x"), nothingToReport: true };
    expect(codeReportProblems(quiet, { ...base, status: "no_git_context" })).toEqual([]);
  });
});
