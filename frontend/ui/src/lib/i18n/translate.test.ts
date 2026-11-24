import { describe, expect, it } from "vitest";
import { DEFAULT_LOCALE, ENABLED_LOCALES, LOCALES, parseLocale } from "./locales";
import { en, type MessageKey } from "./messages/en";
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

function firstUntranslatedKey(): [string, string] {
  for (const [group, values] of Object.entries(en)) {
    const translated = (zh as Record<string, Record<string, string> | undefined>)[group] ?? {};
    const missing = Object.keys(values).find((key) => !(key in translated));
    if (missing) return [group, missing];
  }
  throw new Error("every key is translated, so there is no fallback to test");
}

describe("createTranslator", () => {
  it("returns the English text for English", () => {
    expect(createTranslator("en")("workspaces.emptyTitle")).toBe("No workspaces yet");
  });

  it("returns the translation and falls back to English for a missing key", () => {
    const t = createTranslator("zh");
    expect(t("workspaces.emptyTitle")).toBe("还没有工作空间");
    expect(t("nav.traces")).toBe("追踪");
    // traceroot's own terms keep their English name beside the Chinese one.
    expect(t("nav.detectors")).toBe("检测器 Detectors");
    // A key zh leaves out shows the English text.
    expect(zh.nav?.homeLabel).toBeDefined();
    expect(zh.settings?.modelProviders).toBeDefined();
    expect(zh.common?.settingsFor).toBeDefined();
    const [group, key] = firstUntranslatedKey();
    expect(t(`${group}.${key}` as MessageKey)).toBe(
      (en[group as keyof typeof en] as Record<string, string>)[key],
    );
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
