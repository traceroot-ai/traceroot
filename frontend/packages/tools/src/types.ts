/** JSON-schema fragment for one tool parameter. Plain params arrive flattened
 * (no anyOf-null); structured params (e.g. typed filter arrays) are carried
 * verbatim from the public schema. */
export interface ParamSchema {
  /** A single JSON-schema type, or a list of them for a union the public
   * schema writes out as `["string", "number"]` (the provider-compatible form
   * of an anyOf, used by the alert filter value). */
  type?: string | string[];
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

/**
 * HTTP verbs the registry can express. `get` reads; `post` creates; `patch`
 * partially updates (absent body field = untouched, explicit null = clear);
 * `delete` removes, carrying its arguments in the path and query only.
 *
 * `put` (full replacement: the caller sends the whole resource and the server
 * stores exactly that) is the expected next member, not a rejected one.
 * Adding it is one more value here, one more accepted verb in the generator's
 * method guard, and a `replace_x` curation entry per resource on the same
 * service as its `update_x`. The null rule does not apply to a PUT because its
 * body is complete by definition, so it flattens like a POST.
 */
export type ToolMethod = "get" | "post" | "patch" | "delete";

/** Guardrails a write tool carries; surfaces enforce them before dispatching. */
export interface ToolPolicy {
  /**
   * approvalClass semantics:
   * - "none"     — execute immediately.
   * - "confirm"  — an attended surface shows the proposal and waits for the
   *   user's yes; an unattended surface executes as if "none". A taste gate,
   *   not a security control.
   * - "approval" — destructive ops (deletes). Each surface decides how to
   *   honor it; a surface that has not implemented it fails closed.
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
  /** Args routed to the JSON request body. Present only on entries with a
   * JSON request body (POST and PATCH); a DELETE has none, so its args are
   * path and query params like a GET's. */
  bodyParams?: readonly string[];
  /** Body fields kept in the API/CLI contract but that the agent's tool
   * factory must neither show to the model nor accept from it. The entry's
   * inputSchema/bodyParams stay complete; filtering is the consumer's job. */
  agentHiddenParams?: readonly string[];
  /** Required on every non-GET entry (POST, PATCH, DELETE); validated at
   * generation time. */
  policy?: ToolPolicy;
}
