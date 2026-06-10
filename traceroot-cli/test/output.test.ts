import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { println, eprintln, printError, printWarn, notImplemented, fatal } from "../src/output.js";

describe("output helpers", () => {
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    vi.spyOn(process, "exit").mockImplementation((_code?: number) => {
      throw new Error(`process.exit(${_code ?? "undefined"})`);
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("println writes to stdout with trailing newline", () => {
    println("hello");
    expect(stdoutSpy).toHaveBeenCalledWith("hello\n");
  });

  it("eprintln writes to stderr with trailing newline", () => {
    eprintln("oops");
    expect(stderrSpy).toHaveBeenCalledWith("oops\n");
  });

  it("printError prefixes message with 'error:'", () => {
    printError("something broke");
    expect(stderrSpy).toHaveBeenCalledWith("error: something broke\n");
  });

  it("printWarn prefixes message with 'warn:'", () => {
    printWarn("watch out");
    expect(stderrSpy).toHaveBeenCalledWith("warn: watch out\n");
  });

  it("notImplemented writes to stderr and calls process.exit(1)", () => {
    expect(() => notImplemented("foo bar")).toThrow("process.exit(1)");
    expect(stderrSpy).toHaveBeenCalledWith("foo bar: not yet implemented\n");
  });

  it("fatal writes an error message and exits with the given code", () => {
    expect(() => fatal("critical failure", 2)).toThrow("process.exit(2)");
    expect(stderrSpy).toHaveBeenCalledWith("error: critical failure\n");
  });

  it("fatal defaults to exit code 1", () => {
    expect(() => fatal("boom")).toThrow("process.exit(1)");
  });
});
