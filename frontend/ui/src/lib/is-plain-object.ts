/** A JSON object as a request body or a stored column can carry one: not null, not an array. */
export const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
