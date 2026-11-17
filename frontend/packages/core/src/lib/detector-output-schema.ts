/**
 * The rules for a detector's output schema, shared by the two sides that read
 * one: the write path refuses an entry that breaks them, and the detection
 * worker builds its submit_result tool under them, one field per entry.
 *
 * Dependency-free on purpose, so the rules can be imported wherever a schema is
 * read without bringing the rest of core along.
 */

/** The types the worker builds a tool field for; it reads any other as a string. */
export const OUTPUT_FIELD_TYPES = ["string", "number", "boolean"] as const;

/**
 * Field names with a special meaning on JavaScript objects. A field's name
 * becomes a key on ordinary objects, in the tool's parameters and in the data
 * the model returns: there, assigning `__proto__` replaces the prototype
 * instead of adding a field, `constructor` is already inherited by every
 * object, and `prototype` has its own meaning on functions. A schema is
 * detector-author input, so it is untrusted.
 */
export const RESERVED_FIELD_NAMES: ReadonlySet<string> = new Set([
  "__proto__",
  "prototype",
  "constructor",
]);

/** A name a tool field can carry: a string that is neither blank nor reserved. */
export function isUsableFieldName(name: unknown): name is string {
  return typeof name === "string" && name.trim().length > 0 && !RESERVED_FIELD_NAMES.has(name);
}
