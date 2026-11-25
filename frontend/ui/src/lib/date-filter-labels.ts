import type { DateFilterOption } from "@/lib/date-filter";
import type { MessageKey } from "@/lib/i18n/messages/en";
import type { Translate } from "@/lib/i18n/translate";

// The option labels live with the options in lib/date-filter; this maps each option id to the
// translatable copy of the same text.
const OPTION_LABEL_KEYS: Record<string, MessageKey> = {
  "30m": "componentsDateFilter.last30m",
  "1h": "componentsDateFilter.last1h",
  "3h": "componentsDateFilter.last3h",
  "6h": "componentsDateFilter.last6h",
  "1d": "componentsDateFilter.last1d",
  "7d": "componentsDateFilter.last7d",
  "14d": "componentsDateFilter.last14d",
  "30d": "componentsDateFilter.last30d",
  "60d": "componentsDateFilter.last60d",
  "90d": "componentsDateFilter.last90d",
  custom: "componentsDateFilter.custom",
};

export function dateFilterLabel(t: Translate, option: Pick<DateFilterOption, "id" | "label">) {
  return Object.hasOwn(OPTION_LABEL_KEYS, option.id)
    ? t(OPTION_LABEL_KEYS[option.id])
    : option.label;
}
