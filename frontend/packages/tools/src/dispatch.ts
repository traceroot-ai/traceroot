import type { ApiClient } from "./client.js";
import type { RegistryEntry } from "./types.js";

/** Substitute `{param}` placeholders in a path template with URI-encoded arg values. */
export function fillPath(template: string, args: Record<string, unknown>): string {
  return template.replace(/\{([^{}]+)\}/g, (_match, name: string) => {
    const value = args[name];
    // An empty string is as missing as null for a URL segment: it would
    // produce a path like `/traces/`, which redirects to the list route and
    // silently returns the wrong resource.
    if (value === undefined || value === null || value === "") {
      throw new Error(`Missing or empty path parameter "${name}" for path template "${template}"`);
    }
    return encodeURIComponent(String(value));
  });
}

export interface DispatchOptions {
  /**
   * Alternative path template (e.g. an internal project-scoped route). Extra
   * path params beyond the entry's schema are taken from args.
   */
  pathOverride?: string;
  signal?: AbortSignal;
}

/**
 * Call a registry entry through the given client: fill the path template from
 * args, route the entry's body params into the JSON request body (values kept
 * as-is; the client serializes the whole body once), route the remaining
 * schema params to the query string (scalars stringified, objects and arrays
 * JSON-serialized), ignore unknown args.
 */
export async function dispatch(
  entry: RegistryEntry,
  args: Record<string, unknown>,
  client: ApiClient,
  options: DispatchOptions = {},
): Promise<unknown> {
  const template = options.pathOverride ?? entry.path;
  const path = fillPath(template, args);
  const pathParams = new Set([...template.matchAll(/\{([^{}]+)\}/g)].map((match) => match[1]));
  const bodyParams = new Set(entry.bodyParams ?? []);

  const query: Record<string, string> = {};
  for (const name of Object.keys(entry.inputSchema.properties)) {
    if (pathParams.has(name) || bodyParams.has(name)) {
      continue;
    }
    const value = args[name];
    if (value === undefined || value === null) {
      continue;
    }
    query[name] = typeof value === "object" ? JSON.stringify(value) : String(value);
  }

  if (bodyParams.size === 0) {
    return client.request(entry.method, path, { params: query, signal: options.signal });
  }

  // An entry that declares body params always sends a JSON body (possibly
  // empty) so the endpoint's content type doesn't vary with the arguments.
  const body: Record<string, unknown> = {};
  for (const name of bodyParams) {
    const value = args[name];
    if (value === undefined || value === null) {
      continue;
    }
    body[name] = value;
  }

  return client.request(entry.method, path, { params: query, body, signal: options.signal });
}
