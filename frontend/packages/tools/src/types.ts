/** JSON-schema fragment for one tool parameter. Plain params arrive flattened
 * (no anyOf-null); structured params (e.g. typed filter arrays) are carried
 * verbatim from the public schema. */
export interface ParamSchema {
  type?: string;
  description?: string;
  format?: string;
  [key: string]: unknown;
}

/** Flat JSON-schema object covering an operation's path + query parameters. */
export interface InputSchema {
  type: "object";
  properties: Record<string, ParamSchema>;
  required: string[];
  additionalProperties: false;
}

export type ToolMethod = "get" | "post";

/** Guardrails a write tool carries; surfaces enforce them before dispatching. */
export interface ToolPolicy {
  /**
   * approvalClass semantics:
   * - "none"     — execute immediately.
   * - "confirm"  — an attended surface shows the proposal and waits for the
   *   user's yes; an unattended surface executes as if "none". A taste gate,
   *   not a security control.
   * - "approval" — reserved for destructive ops (future deletes); fail-closed
   *   everywhere today.
   */
  approvalClass: "none" | "confirm" | "approval";
  /** Minimum workspace role; "VIEWER" means no role floor (account-tenancy ops have no membership to gate). */
  minRole: "VIEWER" | "MEMBER" | "ADMIN";
  tenancy: "account" | "workspace" | "project";
}

/**
 * One tool in the shared registry. Inert data — where and how to call the API —
 * generated from the public OpenAPI schema's x-tool curation. Logic lives in
 * the backend service layer; surfaces adapt (client, shape) but never reimplement.
 */
export interface RegistryEntry {
  name: string;
  description: string;
  method: ToolMethod;
  /** Public path template, e.g. "/api/v1/public/traces/{trace_id}". */
  path: string;
  inputSchema: InputSchema;
  /** Args routed to the JSON request body (write ops only). */
  bodyParams?: readonly string[];
  /** Body fields kept in the API/CLI contract but that the agent's tool
   * factory must neither show to the model nor accept from it. The entry's
   * inputSchema/bodyParams stay complete; filtering is the consumer's job. */
  agentHiddenParams?: readonly string[];
  /** Required on every non-GET entry; validated at generation time. */
  policy?: ToolPolicy;
}
