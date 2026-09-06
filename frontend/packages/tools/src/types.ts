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

/**
 * One tool in the shared registry. Inert data — where and how to call the API —
 * generated from the public OpenAPI schema's x-tool curation. Logic lives in
 * the backend service layer; surfaces adapt (client, shape) but never reimplement.
 */
export interface RegistryEntry {
  name: string;
  description: string;
  method: "get";
  /** Public path template, e.g. "/api/v1/public/traces/{trace_id}". */
  path: string;
  inputSchema: InputSchema;
}
