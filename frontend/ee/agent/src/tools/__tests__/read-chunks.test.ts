import { describe, expect, it, vi } from "vitest";
import type { Executor } from "../../executors/interface.js";
import { createReadTool } from "../sandbox.js";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES } from "../truncate.js";

function fileExecutor(contents: string) {
  const exec = vi.fn(async (command: string) => {
    if (command.startsWith("wc -l < ")) {
      return { stdout: String(contents.split("\n").length - 1), stderr: "", code: 0 };
    }
    if (command.startsWith("cat ")) return { stdout: contents, stderr: "", code: 0 };
    const tail = /^tail -n \+(\d+) /.exec(command);
    if (tail) {
      return {
        stdout: contents
          .split("\n")
          .slice(Number(tail[1]) - 1)
          .join("\n"),
        stderr: "",
        code: 0,
      };
    }
    throw new Error(`Unexpected command: ${command}`);
  });
  const executor: Executor = {
    exec,
    init: vi.fn(async () => {}),
    isReady: vi.fn(() => true),
    getWorkspacePath: () => "/workspace",
    writeFile: vi.fn(async () => {}),
    readFile: vi.fn(async () => contents),
    destroy: vi.fn(async () => {}),
    cloneRepo: vi.fn(async () => {}),
  };
  return executor;
}

type ReadResult = Awaited<ReturnType<ReturnType<typeof createReadTool>["execute"]>>;

function outputText(result: ReadResult): string {
  return result.content.map((item) => (item.type === "text" ? item.text : "")).join("");
}

function fragment(result: ReadResult): string {
  const text = outputText(result);
  expect(Buffer.byteLength(text, "utf-8")).toBeLessThanOrEqual(DEFAULT_MAX_BYTES);
  const next = result.details?.nextByteOffset as number | undefined;
  if (next === undefined) return text;
  const hint = `\n\n[Use byteOffset=${next} with the same offset/limit to continue]`;
  expect(text.endsWith(hint)).toBe(true);
  return text.slice(0, -hint.length);
}

const input = { label: "Read trace fixture", path: "/workspace/trace.jsonl" };

describe("read byte continuation", () => {
  it("reads a 60KB ASCII line in bounded chunks without requiring the bash tool", async () => {
    const source = `BEGIN:${"a".repeat(60 * 1024)}:END`;
    const executor = fileExecutor(source);
    const tool = createReadTool(executor);
    const first = await tool.execute("first", input);
    const firstFragment = fragment(first);
    const next = first.details?.nextByteOffset as number;

    expect(firstFragment.startsWith("BEGIN:")).toBe(true);
    expect(next).toBe(Buffer.byteLength(firstFragment, "utf-8"));
    expect(next).toBeGreaterThan(0);
    expect(next).toBeLessThan(Buffer.byteLength(source, "utf-8"));
    expect(outputText(first)).not.toMatch(/use bash/i);

    const last = await tool.execute("last", { ...input, byteOffset: next });
    expect(firstFragment + fragment(last)).toBe(source);
    expect(outputText(last).endsWith(":END")).toBe(true);
    expect(last.details?.nextByteOffset).toBeUndefined();
    expect(outputText(last)).not.toContain("[Use byteOffset=");
    expect(executor.exec).toHaveBeenCalledTimes(4);
    expect(executor.exec).toHaveBeenNthCalledWith(1, "wc -l < '/workspace/trace.jsonl'", {
      signal: undefined,
    });
    expect(executor.exec).toHaveBeenNthCalledWith(2, "cat '/workspace/trace.jsonl'", {
      signal: undefined,
    });
  });

  it.each([
    {
      name: "newline between two oversized lines",
      source: `${"a".repeat(60_000)}\n${"b".repeat(60_000)}`,
    },
    {
      name: "line cap between oversized lines",
      source: `${"a".repeat(60_000)}\n${Array(2500).fill("x").join("\n")}\n${"b".repeat(60_000)}`,
    },
    {
      name: "multiple large JSONL spans",
      source: [
        { input: "a".repeat(60_000), output: "first output" },
        { input: "b".repeat(60_000), output: "second output" },
      ]
        .map((span) => JSON.stringify(span))
        .join("\n"),
    },
  ])("advances and reconstructs $name", async ({ source }) => {
    const tool = createReadTool(fileExecutor(source));
    const fragments: string[] = [];
    let byteOffset = 0;
    for (let page = 0; page < 10; page++) {
      const result = await tool.execute(
        `page-${page}`,
        page === 0 ? input : { ...input, byteOffset },
      );
      const piece = fragment(result);
      expect(piece.split("\n").length).toBeLessThanOrEqual(DEFAULT_MAX_LINES);
      fragments.push(piece);
      const next = result.details?.nextByteOffset as number | undefined;
      if (next === undefined) break;
      expect(next).toBeGreaterThan(byteOffset);
      byteOffset = next;
    }
    expect(fragments.join("")).toBe(source);
  });

  it("keeps byteOffset relative to the same line offset/limit selection", async () => {
    const json = JSON.stringify({ head: "first", body: "x".repeat(60 * 1024), tail: "last" });
    const source = `excluded header\n${json}\nexcluded footer`;
    const executor = fileExecutor(source);
    const tool = createReadTool(executor);
    const selection = { ...input, offset: 2, limit: 1 };
    const first = await tool.execute("first", selection);
    const last = await tool.execute("last", {
      ...selection,
      byteOffset: first.details?.nextByteOffset,
    });
    const combined = fragment(first) + fragment(last);

    expect(combined).toBe(json);
    expect(JSON.parse(combined)).toMatchObject({ head: "first", tail: "last" });
    expect(combined).not.toContain("excluded");
    expect(executor.exec).toHaveBeenNthCalledWith(2, "tail -n +2 '/workspace/trace.jsonl'", {
      signal: undefined,
    });
    expect(last.details?.nextByteOffset).toBeUndefined();
  });

  it("cuts multibyte text at UTF-8 boundaries and reconstructs it without replacement characters", async () => {
    const source = `A${"🙂".repeat(16_000)}尾`;
    const tool = createReadTool(fileExecutor(source));
    const first = await tool.execute("first", input);
    const firstFragment = fragment(first);
    const next = first.details?.nextByteOffset as number;
    const last = await tool.execute("last", { ...input, byteOffset: next });

    expect(next % 4).toBe(1);
    expect(next).toBe(Buffer.byteLength(firstFragment, "utf-8"));
    expect(firstFragment).not.toContain("\uFFFD");
    expect(fragment(last)).not.toContain("\uFFFD");
    expect(firstFragment + fragment(last)).toBe(source);
  });

  it("reads from an explicit valid UTF-8 byte boundary", async () => {
    const tool = createReadTool(fileExecutor("A🙂Z"));
    const result = await tool.execute("boundary", { ...input, byteOffset: 1 });
    expect(outputText(result)).toBe("🙂Z");
    expect(result.details?.nextByteOffset).toBeUndefined();
  });

  it.each([2, 3, 4])("rejects byteOffset %s inside a multibyte character", async (byteOffset) => {
    const tool = createReadTool(fileExecutor("A🙂Z"));
    await expect(tool.execute("bad-boundary", { ...input, byteOffset })).rejects.toThrow(
      "UTF-8 boundary",
    );
  });

  it.each([-1, 0.5, NaN, Infinity, -Infinity, "1", null, {}, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid byteOffset %s before initializing or calling the executor",
    async (byteOffset) => {
      const executor = fileExecutor("data");
      const tool = createReadTool(executor);
      await expect(tool.execute("invalid", { ...input, byteOffset })).rejects.toThrow(
        "byteOffset must be a safe integer >= 0",
      );
      expect(executor.isReady).not.toHaveBeenCalled();
      expect(executor.init).not.toHaveBeenCalled();
      expect(executor.exec).not.toHaveBeenCalled();
    },
  );

  it("rejects an offset beyond the selected content and accepts its exact end", async () => {
    const tool = createReadTool(fileExecutor("hello"));
    await expect(tool.execute("beyond", { ...input, byteOffset: 6 })).rejects.toThrow(
      "beyond the selected content",
    );
    const result = await tool.execute("end", { ...input, byteOffset: 5 });
    expect(outputText(result)).toBe("");
    expect(result.details?.nextByteOffset).toBeUndefined();
  });

  it("preserves ordinary short and line-limited reads", async () => {
    const tool = createReadTool(fileExecutor("first\nsecond\nthird"));
    const whole = await tool.execute("whole", input);
    expect(outputText(whole)).toBe("first\nsecond\nthird");
    expect(whole.details).toBeUndefined();

    const line = await tool.execute("line", { ...input, offset: 2, limit: 1 });
    expect(outputText(line)).toBe("second\n\n[1 more lines in file. Use offset=3 to continue]");
    expect(line.details?.nextByteOffset).toBeUndefined();
  });
});
