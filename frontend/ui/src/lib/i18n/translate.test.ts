import { describe, expect, it } from "vitest";
import { DEFAULT_LOCALE, ENABLED_LOCALES, LOCALES, parseLocale } from "./locales";
import { en } from "./messages/en";
import { zh } from "./messages/zh";
import { createTranslator } from "./translate";

describe("parseLocale", () => {
  it("accepts enabled languages and falls back to English for everything else", () => {
    expect(parseLocale("zh")).toBe("zh");
    expect(parseLocale("en")).toBe("en");
    for (const value of ["ja", "fr", "", "ZH", null, undefined]) {
      expect(parseLocale(value)).toBe(DEFAULT_LOCALE);
    }
  });

  it("keeps Japanese listed but not offered", () => {
    expect(LOCALES.some((locale) => locale.code === "ja")).toBe(true);
    expect(ENABLED_LOCALES.map((locale): string => locale.code)).not.toContain("ja");
  });
});

describe("createTranslator", () => {
  it("returns the English text for English", () => {
    expect(createTranslator("en")("workspaces.emptyTitle")).toBe("No workspaces yet");
  });

  it("returns the translation and falls back to English for a missing key", () => {
    const t = createTranslator("zh");
    expect(t("workspaces.emptyTitle")).toBe("还没有工作空间");
    // Product terms are left out of zh on purpose.
    expect(zh.nav?.traces).toBeUndefined();
    expect(t("nav.traces")).toBe("Tracing");
  });

  it("fills placeholders and leaves unknown ones visible", () => {
    expect(createTranslator("en")("common.settingsFor", { name: "Acme" })).toBe(
      "Settings for Acme",
    );
    expect(createTranslator("zh")("common.settingsFor", { name: "Acme" })).toBe("Acme 的设置");
    expect(createTranslator("en")("common.settingsFor", {})).toBe("Settings for {name}");
  });
});

describe("message files", () => {
  it("has no translated key that English does not define", () => {
    for (const [group, values] of Object.entries(zh)) {
      for (const key of Object.keys(values)) {
        expect(en[group as keyof typeof en], `${group}.${key}`).toHaveProperty(key);
      }
    }
  });

  it("keeps every placeholder of the English text in its translation", () => {
    for (const [group, values] of Object.entries(zh)) {
      for (const [key, text] of Object.entries(values as Record<string, string>)) {
        const english = (en[group as keyof typeof en] as Record<string, string>)[key];
        const placeholders = (value: string) => (value.match(/\{\w+\}/g) ?? []).sort();
        expect(placeholders(text), `${group}.${key}`).toEqual(placeholders(english));
      }
    }
  });
});
