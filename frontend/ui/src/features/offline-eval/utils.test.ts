import { describe, expect, it } from "vitest";
import {
  REVIEW_STATUS_VARIANT,
  RESULT_STATUS_VARIANT,
  SENTIMENT_CLASS,
  caseDisplayId,
  changeSentiment,
  datasetInitCode,
  datasetInitCodeTs,
  datasetPullCode,
  datasetPullCodeTs,
  datasetPullVersionCode,
  datasetPullVersionCodeTs,
  formatStamp,
  parseMetadata,
  pct,
  pctFraction,
  reproduceRunCode,
  reproduceRunCodeTs,
  scoreDisplay,
  signed,
  signedPoints,
  truncate,
} from "./utils";

describe("status variant maps", () => {
  it("maps every result status to a badge tone", () => {
    expect(RESULT_STATUS_VARIANT.passed).toBe("success");
    expect(RESULT_STATUS_VARIANT.failed).toBe("danger");
    expect(RESULT_STATUS_VARIANT.needs_review).toBe("warning");
  });

  it("maps every review status to a badge tone", () => {
    expect(REVIEW_STATUS_VARIANT.ready).toBe("success");
    expect(REVIEW_STATUS_VARIANT.needs_review).toBe("warning");
  });
});

describe("number formatting", () => {
  it("formats percentage points", () => {
    expect(pct(93.75)).toBe("93.8%");
    expect(pct(93.75, 0)).toBe("94%");
  });

  it("formats a 0–1 fraction as a percentage", () => {
    expect(pctFraction(0.857)).toBe("85.7%");
    expect(pctFraction(1, 0)).toBe("100%");
  });

  it("signs a value with a true minus", () => {
    expect(signed(22.4)).toBe("+22.4");
    expect(signed(-9.5)).toBe("−9.5");
    expect(signed(0)).toBe("0.0");
  });

  it("signs a 0–1 delta as percentage points", () => {
    expect(signedPoints(-0.143)).toBe("−14.3");
    expect(signedPoints(0.224)).toBe("+22.4");
  });
});

describe("changeSentiment", () => {
  it("is neutral for no change", () => {
    expect(changeSentiment(0)).toBe("neutral");
  });

  it("reads up as good when higher is better", () => {
    expect(changeSentiment(0.1)).toBe("good");
    expect(changeSentiment(-0.1)).toBe("bad");
  });

  it("inverts when lower is better", () => {
    expect(changeSentiment(0.1, false)).toBe("bad");
    expect(changeSentiment(-0.1, false)).toBe("good");
  });

  it("has a class for every sentiment", () => {
    expect(SENTIMENT_CLASS.good).toContain("emerald");
    expect(SENTIMENT_CLASS.bad).toContain("red");
    expect(SENTIMENT_CLASS.neutral).toContain("muted");
  });
});

describe("scoreDisplay", () => {
  it("renders a dash for a missing score", () => {
    expect(scoreDisplay(null)).toBe("—");
  });

  it("reads 0/1 as Fail/Pass", () => {
    expect(scoreDisplay(1)).toBe("Pass");
    expect(scoreDisplay(0)).toBe("Fail");
  });

  it("reads a fractional score as a rounded percentage", () => {
    expect(scoreDisplay(0.857)).toBe("86%");
  });
});

describe("formatStamp", () => {
  it("delegates to the app-wide absolute timestamp format", () => {
    expect(formatStamp("2026-07-16T15:41:12Z")).toMatch(/2026-07-16/);
  });
});

describe("caseDisplayId", () => {
  it("produces a stable trace-id-looking id", () => {
    const id = caseDisplayId("case-001");
    expect(id).toMatch(/^tc_[0-9a-f]{12}$/);
    expect(id).toHaveLength(15);
    expect(caseDisplayId("case-001")).toBe(id);
  });

  it("distinguishes different case ids", () => {
    expect(caseDisplayId("case-001")).not.toBe(caseDisplayId("case-002"));
  });

  it("handles an empty id", () => {
    expect(caseDisplayId("")).toMatch(/^tc_/);
  });
});

describe("truncate", () => {
  it("leaves a short string alone", () => {
    expect(truncate("short")).toBe("short");
  });

  it("clips past the limit with an ellipsis", () => {
    expect(truncate("abcdef", 4)).toBe("abc…");
  });

  it("leaves a string exactly at the limit alone", () => {
    expect(truncate("abcd", 4)).toBe("abcd");
  });
});

describe("SDK snippets", () => {
  it("embeds the dataset name in the init snippets", () => {
    expect(datasetInitCode("Billing routing")).toContain('Dataset("Billing routing")');
    expect(datasetInitCodeTs("Billing routing")).toContain('dataset("Billing routing")');
  });

  it("embeds the dataset id in the pull snippets", () => {
    expect(datasetPullCode("ds1")).toContain('pull_dataset("ds1")');
    expect(datasetPullCodeTs("ds1")).toContain('pullDataset("ds1")');
  });

  it("embeds the version id in the version-pull snippets", () => {
    expect(datasetPullVersionCode("dv1")).toContain('pull_dataset_version("dv1")');
    expect(datasetPullVersionCodeTs("dv1")).toContain('pullDatasetVersion("dv1")');
  });

  it("pins the version and the baseline run in the reproduce snippets", () => {
    const py = reproduceRunCode("dv1", "Billing routing", "run1");
    expect(py).toContain('pull_dataset_version("dv1")');
    expect(py).toContain('name="Billing routing"');
    expect(py).toContain('baseline="run1"');

    const ts = reproduceRunCodeTs("dv1", "Billing routing", "run1");
    expect(ts).toContain('pullDatasetVersion("dv1")');
    expect(ts).toContain('name: "Billing routing"');
    expect(ts).toContain('baseline: "run1"');
  });
});

describe("parseMetadata", () => {
  it("returns an empty record for missing metadata", () => {
    expect(parseMetadata(null)).toEqual({});
    expect(parseMetadata(undefined)).toEqual({});
    expect(parseMetadata("")).toEqual({});
  });

  it("flattens a JSON object into strings", () => {
    expect(parseMetadata('{"a":1,"b":true,"c":"x"}')).toEqual({ a: "1", b: "true", c: "x" });
  });

  it("shows non-JSON metadata as a single value", () => {
    expect(parseMetadata("plain text")).toEqual({ value: "plain text" });
  });

  it("returns an empty record for valid JSON that is not an object", () => {
    expect(parseMetadata("42")).toEqual({});
    expect(parseMetadata("null")).toEqual({});
  });
});
