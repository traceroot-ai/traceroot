// Role — re-exported from Prisma (runtime object + type)
export { MemberRole as Role } from "@prisma/client";

// SpanKind — ClickHouse values
export const SpanKind = {
  LLM: "LLM",
  AGENT: "AGENT",
  TOOL: "TOOL",
  SPAN: "SPAN",
} as const;
export type SpanKind = (typeof SpanKind)[keyof typeof SpanKind];

// SpanStatus — ClickHouse values
export const SpanStatus = { OK: "OK", ERROR: "ERROR" } as const;
export type SpanStatus = (typeof SpanStatus)[keyof typeof SpanStatus];

// TraceStatus — lowercase, computed at query time
export const TraceStatus = { OK: "ok", ERROR: "error" } as const;
export type TraceStatus = (typeof TraceStatus)[keyof typeof TraceStatus];
