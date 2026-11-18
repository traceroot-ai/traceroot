/**
 * Check a tool call's arguments against the tool's input schema, with errors a
 * model can act on: every bad path, the expected type or values, unknown keys
 * by name (with the likely intended one), and the accepted top-level shape. A
 * call whose arguments arrive wrapped in a single `arguments`, `params`,
 * `input` or `args` object is unwrapped when the inner object is valid.
 *
 * Covers the JSON Schema keywords the registry emits (type, enum, const,
 * numeric and length bounds, items, properties, required,
 * additionalProperties, item and property counts, anyOf); `format` and
 * annotation keywords are left to the API, which validates again.
 */
import type { InputSchema, ParamSchema } from "./types.js";

/** Keys a client sometimes wraps the real arguments in. */
const WRAPPER_KEYS = ["arguments", "params", "input", "args"] as const;

/** Enum values listed in the shape summary before it says "…". */
const SHAPE_ENUM_LIMIT = 8;

export type ArgumentCheck =
  | { ok: true; args: Record<string, unknown>; unwrappedFrom?: string }
  | { ok: false; message: string };

export interface CheckOptions {
  /** Params the surface hides; a value for one gets its own explanation. */
  hidden?: ReadonlySet<string>;
}

interface Issue {
  path: string;
  message: string;
}

type Schema = ParamSchema;

/** Validate `raw` as the arguments of `toolName`. */
export function checkArguments(
  toolName: string,
  schema: InputSchema,
  raw: unknown,
  options: CheckOptions = {},
): ArgumentCheck {
  const args = raw ?? {};
  if (!isPlainObject(args)) {
    return {
      ok: false,
      message: render(
        toolName,
        schema,
        [{ path: "", message: `the arguments must be a JSON object, got ${describe(args)}` }],
        undefined,
      ),
    };
  }
  const issues = checkTopLevel(schema, args, options);
  if (issues.length === 0) {
    return { ok: true, args };
  }
  const wrapper = wrappedArguments(schema, args);
  if (wrapper) {
    const innerIssues = checkTopLevel(schema, wrapper.inner, options);
    if (innerIssues.length === 0) {
      return { ok: true, args: wrapper.inner, unwrappedFrom: wrapper.key };
    }
    return { ok: false, message: render(toolName, schema, innerIssues, wrapper.key) };
  }
  return { ok: false, message: render(toolName, schema, issues, undefined) };
}

/** The inner object when `args` is a lone wrapper key the schema does not declare. */
function wrappedArguments(
  schema: InputSchema,
  args: Record<string, unknown>,
): { key: string; inner: Record<string, unknown> } | undefined {
  const keys = Object.keys(args);
  if (keys.length !== 1) return undefined;
  const key = keys[0]!;
  if (!(WRAPPER_KEYS as readonly string[]).includes(key) || key in schema.properties) {
    return undefined;
  }
  const inner = args[key];
  return isPlainObject(inner) ? { key, inner } : undefined;
}

function checkTopLevel(
  schema: InputSchema,
  args: Record<string, unknown>,
  options: CheckOptions,
): Issue[] {
  const issues: Issue[] = [];
  for (const name of schema.required) {
    if (args[name] === undefined) {
      issues.push({ path: "", message: `missing required argument "${name}"` });
    }
  }
  const known = Object.keys(schema.properties);
  for (const [name, value] of Object.entries(args)) {
    const property = schema.properties[name];
    if (property === undefined) {
      if (value === undefined) continue;
      if (options.hidden?.has(name)) {
        issues.push({
          path: "",
          message: `argument "${name}" is not accepted here; leave it out (the connection already decides it)`,
        });
        continue;
      }
      const guess = closest(name, known);
      issues.push({
        path: "",
        message: `unknown argument "${name}"${guess ? ` (did you mean "${guess}"?)` : ""}`,
      });
      continue;
    }
    if (value === undefined) continue;
    checkValue(property, value, name, issues);
  }
  return issues;
}

function checkValue(schema: Schema, value: unknown, path: string, issues: Issue[]): void {
  if (Array.isArray(schema.anyOf)) {
    checkAnyOf(schema.anyOf as Schema[], value, path, issues);
    return;
  }
  if (schema.const !== undefined && !sameJson(schema.const, value)) {
    issues.push({
      path,
      message: `expected ${JSON.stringify(schema.const)}, got ${describe(value)}`,
    });
    return;
  }
  const types = schema.type === undefined ? [] : [schema.type].flat();
  if (types.length > 0 && !types.some((type) => hasType(value, type))) {
    issues.push({ path, message: `expected ${types.join(" or ")}, got ${describe(value)}` });
    return;
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((option) => sameJson(option, value))) {
    issues.push({
      path,
      message: `expected one of ${schema.enum.map((option) => JSON.stringify(option)).join(", ")}, got ${describe(value)}`,
    });
    return;
  }
  if (typeof value === "number") {
    checkBound(schema.minimum, value, path, issues, (min) => value >= min, "at least");
    checkBound(schema.maximum, value, path, issues, (max) => value <= max, "at most");
    checkBound(schema.exclusiveMinimum, value, path, issues, (min) => value > min, "more than");
    checkBound(schema.exclusiveMaximum, value, path, issues, (max) => value < max, "less than");
  }
  if (typeof value === "string") {
    if (typeof schema.minLength === "number" && value.length < schema.minLength) {
      issues.push({ path, message: `must be at least ${schema.minLength} characters long` });
    }
    if (typeof schema.maxLength === "number" && value.length > schema.maxLength) {
      issues.push({
        path,
        message: `must be at most ${schema.maxLength} characters long, got ${value.length}`,
      });
    }
  }
  if (Array.isArray(value)) {
    if (typeof schema.minItems === "number" && value.length < schema.minItems) {
      issues.push({
        path,
        message: `needs at least ${schema.minItems} item(s), got ${value.length}`,
      });
    }
    if (typeof schema.maxItems === "number" && value.length > schema.maxItems) {
      issues.push({
        path,
        message: `takes at most ${schema.maxItems} item(s), got ${value.length}`,
      });
    }
    if (isPlainObject(schema.items)) {
      value.forEach((item, index) =>
        checkValue(schema.items as Schema, item, `${path}[${index}]`, issues),
      );
    }
  }
  if (isPlainObject(value)) {
    checkObject(schema, value, path, issues);
  }
}

function checkObject(
  schema: Schema,
  value: Record<string, unknown>,
  path: string,
  issues: Issue[],
): void {
  const properties = isPlainObject(schema.properties)
    ? (schema.properties as Record<string, Schema>)
    : {};
  const required = Array.isArray(schema.required) ? (schema.required as string[]) : [];
  for (const name of required) {
    if (value[name] === undefined) {
      issues.push({ path, message: `missing required field "${name}"` });
    }
  }
  if (
    typeof schema.maxProperties === "number" &&
    Object.keys(value).length > schema.maxProperties
  ) {
    issues.push({ path, message: `takes at most ${schema.maxProperties} field(s)` });
  }
  const known = Object.keys(properties);
  for (const [name, item] of Object.entries(value)) {
    const child = `${path}.${name}`;
    if (name in properties) {
      checkValue(properties[name]!, item, child, issues);
    } else if (schema.additionalProperties === false) {
      const guess = closest(name, known);
      issues.push({
        path,
        message: `unknown field "${name}"${guess ? ` (did you mean "${guess}"?)` : ""}`,
      });
    } else if (isPlainObject(schema.additionalProperties)) {
      checkValue(schema.additionalProperties as Schema, item, child, issues);
    }
  }
}

/**
 * A union passes when any branch does. When it fails, the branch whose `const`
 * fields the value already matches (a discriminated union) explains why;
 * otherwise the branch with the fewest problems does.
 */
function checkAnyOf(branches: Schema[], value: unknown, path: string, issues: Issue[]): void {
  let best: Issue[] | undefined;
  let bestScore = -1;
  for (const branch of branches) {
    const found: Issue[] = [];
    checkValue(branch, value, path, found);
    if (found.length === 0) return;
    const score = discriminatorMatches(branch, value) * 1000 - found.length;
    if (score > bestScore) {
      best = found;
      bestScore = score;
    }
  }
  issues.push(...(best ?? [{ path, message: "does not match any accepted shape" }]));
}

function discriminatorMatches(branch: Schema, value: unknown): number {
  if (!isPlainObject(value) || !isPlainObject(branch.properties)) return 0;
  let matches = 0;
  for (const [name, property] of Object.entries(branch.properties as Record<string, Schema>)) {
    if (property.const !== undefined && sameJson(property.const, value[name])) matches++;
  }
  return matches;
}

function checkBound(
  bound: unknown,
  value: number,
  path: string,
  issues: Issue[],
  holds: (bound: number) => boolean,
  wording: string,
): void {
  if (typeof bound === "number" && !holds(bound)) {
    issues.push({ path, message: `must be ${wording} ${bound}, got ${value}` });
  }
}

function hasType(value: unknown, type: string): boolean {
  switch (type) {
    case "string":
      return typeof value === "string";
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "boolean":
      return typeof value === "boolean";
    case "array":
      return Array.isArray(value);
    case "object":
      return isPlainObject(value);
    case "null":
      return value === null;
    default:
      return true;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** A short description of a value the caller sent: its type, and for a scalar the value. */
function describe(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  if (typeof value === "object") return "an object";
  if (typeof value === "string") {
    const shown = value.length > 40 ? `${value.slice(0, 40)}…` : value;
    return `string ${JSON.stringify(shown)}`;
  }
  return `${typeof value} ${String(value)}`;
}

/** The known name the caller most likely meant, if one is close. */
function closest(name: string, known: readonly string[]): string | undefined {
  const squash = (text: string) => text.toLowerCase().replace(/[_\-\s]/g, "");
  const exact = known.find((candidate) => squash(candidate) === squash(name));
  if (exact) return exact;
  let best: string | undefined;
  let bestDistance = 3;
  for (const candidate of known) {
    const distance = editDistance(squash(name), squash(candidate));
    if (distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return best;
}

function editDistance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      current[j] = Math.min(
        previous[j]! + 1,
        current[j - 1]! + 1,
        previous[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  return previous[b.length]!;
}

/** The accepted top-level shape, one entry per argument. */
export function describeShape(schema: InputSchema): string {
  const required = new Set(schema.required);
  const fields = Object.entries(schema.properties).map(([name, property]) => {
    const suffix = required.has(name) ? " (required)" : "";
    return `"${name}": ${typeLabel(property)}${suffix}`;
  });
  return `{${fields.join(", ")}}`;
}

function typeLabel(schema: Schema): string {
  if (Array.isArray(schema.enum)) {
    const shown = schema.enum.slice(0, SHAPE_ENUM_LIMIT).map((option) => JSON.stringify(option));
    return shown.join(" | ") + (schema.enum.length > SHAPE_ENUM_LIMIT ? " | …" : "");
  }
  if (Array.isArray(schema.anyOf)) return "object (one of several shapes; see the schema)";
  const types = schema.type === undefined ? ["any"] : [schema.type].flat();
  return types
    .map((type) =>
      type === "array" && isPlainObject(schema.items)
        ? `array of ${typeLabel(schema.items as Schema)}`
        : type,
    )
    .join(" | ");
}

function render(
  toolName: string,
  schema: InputSchema,
  issues: Issue[],
  wrapperKey: string | undefined,
): string {
  const lines = [`Invalid arguments for ${toolName}:`];
  for (const issue of issues) {
    lines.push(issue.path ? `- ${issue.path}: ${issue.message}` : `- ${issue.message}`);
  }
  if (wrapperKey) {
    lines.push(
      `The arguments were read from inside "${wrapperKey}"; send them at the top level instead.`,
    );
  }
  lines.push(
    `${toolName} takes one flat JSON object: ${describeShape(schema)}. Fix the arguments above and call again.`,
  );
  return lines.join("\n");
}
