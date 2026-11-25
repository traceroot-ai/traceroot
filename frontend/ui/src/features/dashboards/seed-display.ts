import type { MessageKey } from "@/lib/i18n/messages/en";
import type { Translate } from "@/lib/i18n/translate";

// Every project starts with one dashboard whose name and widget titles are written to the
// database in English (lib/dashboard-seed.ts). They are data, so they are stored once and not
// re-seeded per language; these maps translate them when shown, while they still carry the
// seeded text. A title the user has edited matches nothing here and is shown as typed.
const SEEDED_WIDGET_TITLE_KEYS: Record<string, MessageKey> = {
  "Trace count": "dashboardsSeed.traceCount",
  "Total cost": "dashboardsSeed.totalCost",
  Tokens: "dashboardsSeed.tokens",
  "p95 latency": "dashboardsSeed.p95Latency",
  "Cost over time · by model": "dashboardsSeed.costOverTime",
  "Tokens by model": "dashboardsSeed.tokensByModel",
  "Recent traces": "dashboardsSeed.recentTraces",
  "Recent failures": "dashboardsSeed.recentFailures",
};

const SEEDED_DASHBOARD_NAME = "Default";

export function displayWidgetTitle(t: Translate, title: string): string {
  const key = SEEDED_WIDGET_TITLE_KEYS[title];
  return key ? t(key) : title;
}

// The widget schema (backend/rest/services/widget_registry.py) labels its fields in English for
// every client. Labels that are plain words get a translation when shown; product terms
// (Trace ID, Tokens) and any label the schema adds later are shown as they arrive.
const FIELD_LABEL_KEYS: Record<string, MessageKey> = {
  "Span name": "componentsFilters.fieldSpanName",
  "Span kind": "componentsFilters.fieldSpanKind",
  Status: "componentsFilters.fieldStatus",
  "Error type": "componentsFilters.fieldErrorType",
  Model: "componentsFilters.fieldModel",
  Environment: "componentsFilters.fieldEnvironment",
  Cost: "componentsFilters.fieldCost",
  Latency: "componentsFilters.fieldLatency",
  Errors: "componentsFilters.fieldErrors",
  Duration: "evalsShared.duration",
  Metadata: "tracesSpan.metadata",
  Count: "alertsMeasures.labelCount",
  "Input tokens": "alertsMeasures.labelInputTokens",
  "Output tokens": "alertsMeasures.labelOutputTokens",
  "Total tokens": "alertsMeasures.labelTotalTokens",
  "Cache read tokens": "dashboardsFields.cacheReadTokens",
  "Cache write tokens": "dashboardsFields.cacheWriteTokens",
  "Tokens per second": "dashboardsFields.tokensPerSecond",
  "Trace name": "dashboardsFields.traceName",
  "Root span": "dashboardsFields.rootSpan",
  User: "dashboardsFields.user",
  Session: "dashboardsFields.session",
};

export function displayFieldLabel(t: Translate, label: string): string {
  return Object.hasOwn(FIELD_LABEL_KEYS, label) ? t(FIELD_LABEL_KEYS[label]) : label;
}

export function displayDashboardName(t: Translate, name: string): string {
  return name === SEEDED_DASHBOARD_NAME ? t("dashboardsSeed.defaultName") : name;
}
