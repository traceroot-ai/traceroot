/**
 * Typed stubs for the TraceRoot public API.
 *
 * NOT YET GENERATED — these are hand-written placeholders that will be
 * replaced by codegen output in #1084 (Vendor public OpenAPI schema and
 * generate typed client). Run `npm run codegen` once that lands.
 */

export interface Trace {
  traceId: string;
  rootSpanId: string;
  startTime: string;
  endTime: string;
  durationMs: number;
  rootServiceName: string;
  rootName: string;
  status: "ok" | "error" | "unset";
}

export interface Span {
  spanId: string;
  parentSpanId?: string;
  traceId: string;
  name: string;
  serviceName: string;
  startTime: string;
  endTime: string;
  durationMs: number;
  status: "ok" | "error" | "unset";
  attributes?: Record<string, string | number | boolean>;
}

export interface ListTracesResponse {
  traces: Trace[];
  nextCursor?: string;
}

export interface GetTraceResponse {
  trace: Trace;
  spans: Span[];
}
