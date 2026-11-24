import { DEFAULT_LOCALE, type Locale } from "./locales";
import { en, type MessageKey, type PartialMessages } from "./messages/en";
import { zh } from "./messages/zh";

const translations: Partial<Record<Locale, PartialMessages>> = { zh };

export type TranslateValues = Record<string, string | number>;
export type Translate = (key: MessageKey, values?: TranslateValues) => string;

/**
 * Looks a key such as "nav.traces" up in the language, then in English, so a language can ship
 * partly translated. `{name}` placeholders are replaced from `values`.
 */
export function createTranslator(locale: Locale): Translate {
  const translated = locale === DEFAULT_LOCALE ? undefined : translations[locale];
  return (key, values) => {
    const [group, name] = key.split(".") as [keyof typeof en, string];
    const english = (en[group] as Record<string, string>)[name];
    const text = (translated?.[group] as Record<string, string> | undefined)?.[name] ?? english;
    if (!values) return text;
    return text.replace(/\{(\w+)\}/g, (placeholder, value: string) =>
      value in values ? String(values[value]) : placeholder,
    );
  };
}
