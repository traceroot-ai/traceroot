import { describe, it, expect } from "vitest";
import { analyzeBreakdown } from "./breakdown-chart";

describe("analyzeBreakdown", () => {
  it("detects the issue #1383 stage/duration/percentage/issue table", () => {
    const headers = ["Stage", "Duration", "Percentage", "Issue"];
    const rows = [
      ["Data loading", "33s", "27%", "Cold cache"],
      ["Model inference", "65s", "53%", "Serial calls"],
      ["Result write", "26s", "21%", "Batch write blocks"],
    ];
    const result = analyzeBreakdown(headers, rows);
    expect(result).not.toBeNull();
    expect(result!.hasDuration).toBe(true);
    expect(result!.hasPercent).toBe(true);
    expect(result!.items).toHaveLength(3);
    expect(result!.items[1]).toMatchObject({ label: "Model inference", percent: 53 });
    expect(result!.items[1].durationMs).toBe(65_000);
    expect(result!.items[0].extras[0]).toMatchObject({ header: "Issue", value: "Cold cache" });
  });

  it("detects the Chinese-column variant (阶段 / 耗时 / 占比 / 问题)", () => {
    const result = analyzeBreakdown(
      ["阶段", "耗时", "占比", "问题"],
      [
        ["数据加载", "33s", "27%", "冷缓存"],
        ["模型推理", "65s", "53%", "串行调用"],
        ["结果写入", "26s", "21%", "批量写入阻塞"],
      ],
    );
    expect(result).not.toBeNull();
    expect(result!.items.map((i) => i.label)).toEqual(["数据加载", "模型推理", "结果写入"]);
  });

  it("derives proportions from duration when no percentage column exists", () => {
    const result = analyzeBreakdown(
      ["Stage", "Time"],
      [
        ["A", "2m 30s"],
        ["B", "2m 30s"],
      ],
    );
    expect(result).not.toBeNull();
    expect(result!.hasPercent).toBe(false);
    expect(result!.items[0].durationMs).toBe(150_000);
  });

  it("parses bare numbers when the header names a unit", () => {
    const result = analyzeBreakdown(
      ["Step", "Duration (ms)"],
      [
        ["load", "1200"],
        ["run", "3400"],
      ],
    );
    expect(result).not.toBeNull();
    expect(result!.items[1].durationMs).toBe(3400);
  });

  it("ignores ordinary tables with no duration or percentage", () => {
    const result = analyzeBreakdown(
      ["Name", "Role"],
      [
        ["Alice", "Admin"],
        ["Bob", "User"],
      ],
    );
    expect(result).toBeNull();
  });

  it("does not treat version-like tokens as durations", () => {
    const result = analyzeBreakdown(
      ["Model", "Notes"],
      [
        ["gpt-4s", "fast"],
        ["claude", "slow"],
      ],
    );
    expect(result).toBeNull();
  });

  it("requires at least two rows", () => {
    const result = analyzeBreakdown(["Stage", "Duration", "%"], [["only", "5s", "100%"]]);
    expect(result).toBeNull();
  });
});
