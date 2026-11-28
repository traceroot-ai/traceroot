import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const srcDir = join(import.meta.dirname, "..");

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      return entry.name === "__tests__" ? [] : sources(path);
    }
    return path.endsWith(".ts") ? [path] : [];
  });
}

describe("service secrets", () => {
  it("never reads the internal API secret or a database URL", () => {
    for (const file of sources(srcDir)) {
      const text = readFileSync(file, "utf8");
      expect(text, file).not.toMatch(/INTERNAL_API_SECRET|DATABASE_URL|POSTGRES|CLICKHOUSE/);
    }
  });
});
