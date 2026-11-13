import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const css = readFileSync(path.resolve(__dirname, "../app/globals.css"), "utf8");

function block(selector: string): Record<string, string> {
  const m = css.match(new RegExp(`(?:^|\\n)${selector.replace(".", "\\.")}\\s*\\{([^}]*)\\}`));
  if (!m) throw new Error(`missing ${selector} block`);
  return Object.fromEntries(
    [...m[1].matchAll(/--([\w-]+):\s*([^;]+);/g)].map((x) => [x[1], x[2].trim()]),
  );
}

function luminance(hsl: string): number {
  const [h, s, l] = hsl.match(/[\d.]+/g)!.map(Number);
  const a = (s / 100) * Math.min(l / 100, 1 - l / 100);
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    const c = l / 100 - a * Math.max(-1, Math.min(k - 3, Math.min(9 - k, 1)));
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(0) + 0.7152 * f(8) + 0.0722 * f(4);
}

function ratio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

// Text pairs that must meet WCAG AA (4.5:1) in both themes.
const TEXT_PAIRS: [string, string][] = [
  ["foreground", "background"],
  ["card-foreground", "card"],
  ["popover-foreground", "popover"],
  ["muted-foreground", "background"],
  ["muted-foreground", "muted"],
  ["secondary-foreground", "secondary"],
  ["accent-foreground", "accent"],
  ["destructive-foreground", "destructive"],
  ["primary-ink", "primary"],
  ["destructive", "background"],
  ["destructive", "card"],
  ["brand", "background"],
  ["brand", "brand-soft"],
  ["success", "success-soft"],
  ["warning", "warning-soft"],
  ["danger", "danger-soft"],
  ["info", "info-soft"],
];

describe.each([
  ["light", ":root"],
  ["dark", ".dark"],
])("design tokens (%s)", (_name, selector) => {
  const tokens = block(selector);

  it.each(TEXT_PAIRS)("%s on %s meets AA 4.5:1", (fg, bg) => {
    expect(tokens[fg], `--${fg}`).toBeDefined();
    expect(tokens[bg], `--${bg}`).toBeDefined();
    expect(ratio(tokens[fg], tokens[bg])).toBeGreaterThanOrEqual(4.5);
  });

  // primary-foreground on primary (2.39:1) is a brand exception for solid
  // controls only; non-control text on primary uses primary-ink (AA above).
  it("uses the website's teal and warm white for solid primary surfaces", () => {
    expect(tokens.primary).toBe("177.07 80.39% 40%");
    expect(tokens["primary-foreground"]).toBe("36 100% 98.04%");
  });

  // Non-text UI (focus ring) needs 3:1 against the page (WCAG 1.4.11).
  it("focus ring meets 3:1 on the page and on cards", () => {
    expect(ratio(tokens.ring, tokens.background)).toBeGreaterThanOrEqual(3);
    expect(ratio(tokens.ring, tokens.card)).toBeGreaterThanOrEqual(3);
  });
});
